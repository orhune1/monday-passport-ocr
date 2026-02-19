const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

const COLUMN_MAP = {
    first_name: "text_mm0qv8de",
    last_name: "text_mm0qgd7q",
    gender: "text_mm0qkzhv",
    passport_number: "text_mm0qj5f2",
    national_id_number: "text_mm0qwvat",
    date_of_birth: "date_mm0qj1wq",
    date_of_issue: "date_mm0qmqz2",
    date_of_expiry: "date_mm0q1gcb",
    issuing_authority: "text_mm0qqgs4",
    place_of_birth: "text_mm0qgsv0",
};

// ---------------------------------------------------------------------------
// Monday.com GraphQL
// ---------------------------------------------------------------------------
async function mondayQuery(query, variables = {}) {
    const res = await fetch(MONDAY_API_URL, {
        method: "POST",
        headers: {
            "Authorization": MONDAY_API_KEY,
            "Content-Type": "application/json",
            "API-Version": "2024-10",
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Monday API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.errors) throw new Error(`Monday GQL: ${JSON.stringify(data.errors)}`);
    return data;
}

// ---------------------------------------------------------------------------
// Step 1: Get image URL from Monday item
// ---------------------------------------------------------------------------
async function getImageUrl(itemId) {
    const colResult = await mondayQuery(
        `query ($ids: [ID!]!) {
            items(ids: $ids) {
                id name
                column_values { id type value }
            }
        }`,
        { ids: [String(itemId)] }
    );

    const item = colResult.data?.items?.[0];
    if (!item) throw new Error(`Item ${itemId} not found.`);

    const assetIds = [];
    for (const cv of item.column_values || []) {
        if (cv.type === "file" && cv.value) {
            try {
                const fv = JSON.parse(cv.value);
                if (fv.files) fv.files.forEach(f => { if (f.assetId) assetIds.push(String(f.assetId)); });
            } catch { }
        }
    }
    if (!assetIds.length) throw new Error(`No files on item "${item.name}".`);

    const assetResult = await mondayQuery(
        `query ($ids: [ID!]!) { assets(ids: $ids) { id name public_url file_extension } }`,
        { ids: assetIds }
    );

    const assets = assetResult.data?.assets || [];
    if (!assets.length) throw new Error(`No public URLs for assets: ${assetIds.join(", ")}`);

    const imgExts = new Set(["png", "jpg", "jpeg", "webp", "bmp", "tiff"]);
    const img = assets.find(a => imgExts.has((a.file_extension || "").toLowerCase().replace(".", ""))) || assets[0];
    if (!img.public_url) throw new Error(`No public URL for "${img.name}".`);

    return img.public_url;
}

// ---------------------------------------------------------------------------
// Step 2: Download image → base64
// ---------------------------------------------------------------------------
async function downloadImage(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
    const buf = await res.buffer();
    const ct = res.headers.get("content-type") || "image/jpeg";
    const mt = ct.includes("png") ? "image/png" : ct.includes("webp") ? "image/webp" : "image/jpeg";
    return { base64: buf.toString("base64"), mediaType: mt };
}

// ---------------------------------------------------------------------------
// Step 3: Gemini Vision OCR
// ---------------------------------------------------------------------------
async function extractPassport(base64, mediaType) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `You are an expert OCR assistant specialised in Turkish passports.
Analyse the passport image carefully, including the MRZ zone.
Return ONLY a raw JSON object (no markdown, no backticks, no explanation):
{
  "first_name": "",
  "last_name": "",
  "gender": "",
  "passport_number": "",
  "national_id_number": "",
  "date_of_birth": "DD/MM/YYYY",
  "date_of_issue": "DD/MM/YYYY",
  "date_of_expiry": "DD/MM/YYYY",
  "issuing_authority": "",
  "place_of_birth": ""
}
Rules:
- Use DD/MM/YYYY format for all dates
- national_id_number is the 11-digit TC Kimlik No
- gender should be "E" for male, "K" for female
- Use empty string "" for any field you cannot read
- Return ONLY the JSON object, nothing else`;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: mediaType, data: base64 } }
                ]
            }],
            generationConfig: { temperature: 0.0, maxOutputTokens: 1000 },
        }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API ${res.status}: ${errText}`);
    }

    const data = await res.json();
    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) throw new Error(`Empty Gemini response: ${JSON.stringify(data)}`);

    // Strip markdown code fences if present
    if (raw.startsWith("```")) {
        raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    }

    return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Step 4: Update Monday item
// ---------------------------------------------------------------------------
async function updateItem(boardId, itemId, data) {
    function toISO(ddmmyyyy) {
        if (!ddmmyyyy || ddmmyyyy.length !== 10) return null;
        const parts = ddmmyyyy.split("/");
        if (parts.length !== 3) return null;
        const [dd, mm, yyyy] = parts;
        if (!/^\d{2}$/.test(dd) || !/^\d{2}$/.test(mm) || !/^\d{4}$/.test(yyyy)) return null;
        const d = parseInt(dd), m = parseInt(mm), y = parseInt(yyyy);
        if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
        return `${yyyy}-${mm}-${dd}`;
    }

    const cv = {};

    // Text columns
    ["first_name", "last_name", "gender", "passport_number", "national_id_number", "issuing_authority", "place_of_birth"]
        .forEach(f => { if (COLUMN_MAP[f] && data[f]) cv[COLUMN_MAP[f]] = data[f]; });

    // Date columns
    ["date_of_birth", "date_of_issue", "date_of_expiry"].forEach(f => {
        const iso = toISO(data[f]);
        if (COLUMN_MAP[f] && iso) {
            cv[COLUMN_MAP[f]] = { date: iso };
        } else if (data[f]) {
            console.log(`  Skipping invalid date for ${f}: "${data[f]}"`);
        }
    });

    if (Object.keys(cv).length === 0) {
        throw new Error("No valid data to update.");
    }

    console.log("  Updating columns:", JSON.stringify(cv));

    return mondayQuery(
        `mutation ($b: ID!, $i: ID!, $v: JSON!) {
            change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id name }
        }`,
        { b: String(boardId), i: String(itemId), v: JSON.stringify(cv) }
    );
}

// ---------------------------------------------------------------------------
// Webhook Endpoint
// ---------------------------------------------------------------------------
app.post("/api/webhook", async (req, res) => {
    // Monday.com webhook challenge
    if (req.body?.challenge) {
        return res.status(200).json({ challenge: req.body.challenge });
    }

    try {
        const event = req.body?.event || req.body;
        const itemId = event?.itemId || event?.pulseId;
        const boardId = event?.boardId || "5092025623";

        if (!itemId) {
            return res.status(400).json({ error: "Missing itemId", body: req.body });
        }

        console.log(`[${new Date().toISOString()}] Processing item ${itemId}`);

        // 1. Get image URL from Monday
        const imageUrl = await getImageUrl(itemId);
        console.log("  Image URL obtained");

        // 2. Download image
        const { base64, mediaType } = await downloadImage(imageUrl);
        console.log(`  Image downloaded (${Math.round(base64.length / 1024)} KB)`);

        // 3. Extract passport data via Gemini
        const passportData = await extractPassport(base64, mediaType);
        console.log("  Extracted:", JSON.stringify(passportData));

        // 4. Update Monday item
        await updateItem(boardId, itemId, passportData);
        console.log("  Monday item updated!");

        return res.status(200).json({ success: true, data: passportData });

    } catch (err) {
        console.error("Error:", err.message);
        return res.status(500).json({ error: err.message });
    }
});

// Health check
app.get("/", (req, res) => {
    res.json({ status: "ok", service: "monday-passport-ocr", version: "2.0" });
});

app.listen(PORT, () => {
    console.log(`Passport OCR server running on port ${PORT}`);
});
