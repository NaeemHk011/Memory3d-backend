require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "20mb" }));

// ── Health check ──
app.get("/", (req, res) => {
  res.json({ status: "Memory3D API running" });
});

// ── Order Submit ──
app.post("/api/submit", async (req, res) => {
  const { GHL_PRIVATE_TOKEN, GHL_LOCATION_ID, GHL_PIPELINE_ID, GHL_STAGE_ID, IMGBB_API_KEY } = process.env;

  if (!GHL_PRIVATE_TOKEN || !GHL_LOCATION_ID || !GHL_PIPELINE_ID || !GHL_STAGE_ID) {
    return res.status(500).json({ error: "Server misconfigured: missing GHL environment variables." });
  }

  const { name, email, phone, cartItems, totalPrice, photoBase64, photoName } = req.body || {};

  if (!name || !email || !phone) {
    return res.status(400).json({ error: "Missing required fields: name, email, phone" });
  }

  // ── Upload photo to imgbb ──
  let photoUrl = null;
  if (photoBase64 && IMGBB_API_KEY) {
    try {
      const imageData = photoBase64.replace(/^data:image\/\w+;base64,/, "");
      const formBody = new URLSearchParams({ image: imageData });
      const imgbbRes = await fetch(
        `https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`,
        { method: "POST", body: formBody }
      );
      const imgbbData = await imgbbRes.json();
      if (imgbbData.success) {
        photoUrl = imgbbData.data.url;
        console.log("Photo uploaded:", photoUrl);
      } else {
        console.error("imgbb error:", JSON.stringify(imgbbData));
      }
    } catch (e) {
      console.error("Photo upload failed:", e.message);
    }
  }

  // ── Save photo locally as backup ──
  if (photoBase64 && photoName) {
    try {
      const uploadsDir = path.join(__dirname, "uploads");
      fs.mkdirSync(uploadsDir, { recursive: true });
      const ext = path.extname(photoName) || ".jpg";
      const filename = `order_${Date.now()}${ext}`;
      const imageData = photoBase64.replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(imageData, "base64"));
      console.log("Photo saved locally:", filename);
    } catch (e) {
      console.error("Local save failed:", e.message);
    }
  }

  const [firstName, ...rest] = name.trim().split(" ");
  const lastName = rest.join(" ") || "";

  try {
    // ── Step 1: Upsert contact ──
    const contactRes = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GHL_PRIVATE_TOKEN}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ firstName, lastName, email, phone, locationId: GHL_LOCATION_ID }),
    });

    if (!contactRes.ok) {
      const err = await contactRes.text();
      console.error("GHL contact error:", err);
      return res.status(500).json({ error: "Failed to create contact in GHL" });
    }

    const contactData = await contactRes.json();
    const contactId = contactData.contact?.id;

    if (!contactId) {
      console.error("No contactId returned:", JSON.stringify(contactData));
      return res.status(500).json({ error: "No contact ID returned from GHL" });
    }

    // ── Step 2: Build opportunity name ──
    const itemNames =
      Array.isArray(cartItems) && cartItems.length > 0
        ? cartItems.map((i) => i.sizeLabel ? `${i.shapeLabel} (${i.sizeLabel})` : i.shapeLabel).join(", ")
        : "Order";

    const orderName = `${itemNames} - Order #${Date.now()}`;
    console.log("Opportunity:", orderName);

    // ── Step 3: Create opportunity ──
    const oppRes = await fetch("https://services.leadconnectorhq.com/opportunities/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GHL_PRIVATE_TOKEN}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: orderName,
        contactId,
        pipelineId: GHL_PIPELINE_ID,
        pipelineStageId: GHL_STAGE_ID,
        status: "open",
        monetaryValue: totalPrice || 0,
        locationId: GHL_LOCATION_ID,
      }),
    });

    if (!oppRes.ok) {
      const errText = await oppRes.text();
      let errData = {};
      try { errData = JSON.parse(errText); } catch {}

      // Duplicate opportunity → update existing
      if (oppRes.status === 400 && errData.meta?.existingId) {
        const updateRes = await fetch(
          `https://services.leadconnectorhq.com/opportunities/${errData.meta.existingId}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${GHL_PRIVATE_TOKEN}`,
              Version: "2021-07-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: orderName, status: "open", monetaryValue: totalPrice || 0 }),
          }
        );
        if (!updateRes.ok) {
          const updateErr = await updateRes.text();
          console.error("GHL update opportunity error:", updateErr);
          return res.status(500).json({ error: "Failed to update opportunity in GHL" });
        }
        console.log("Updated existing opportunity:", errData.meta.existingId);
      } else {
        console.error("GHL opportunity error:", errText);
        return res.status(500).json({ error: "Failed to create opportunity in GHL" });
      }
    }

    // ── Step 4: Add note to contact ──
    const noteLines = [
      `Order: ${orderName}`,
      `Total: $${totalPrice || 0}`,
    ];
    if (Array.isArray(cartItems) && cartItems.length > 0) {
      cartItems.forEach((item) => {
        noteLines.push(`- ${item.shapeLabel}${item.sizeLabel ? ` | Size: ${item.sizeLabel}` : ""} | $${item.price}`);
      });
    }
    noteLines.push(photoUrl ? `\nCustomer Photo: ${photoUrl}` : "\nNo photo uploaded.");

    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GHL_PRIVATE_TOKEN}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: noteLines.join("\n") }),
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Memory3D API running at http://localhost:${PORT}`);
});
