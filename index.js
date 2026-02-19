const express = require("express");
const fetch = require("node-fetch");
const Tesseract = require("tesseract.js");

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_KEY = process.env.MONDAY_API_KEY;
const PORT = process.env.PORT || 3000;

// Board ID: 5092025623
const COLUMN_MAP = {
    first_name: "text_mm0qv8de",
    last_name: "text_mm0qgd7q",
    gender: "text_mm0qkzhv",
    passport_number: "text_mm0qj5f2",
    national_id_number: "text_mm0qwvat",
    date_of_birth: "date_mm0qj1wq",
    date_of_expiry: "date_mm0q1gcb",
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
// Step 2: Tesseract OCR
// ---------------------------------------------------------------------------
async function ocrImage(imageUrl) {
    console.log("  Running Tesseract OCR...");
    const worker = await Tesseract.createWorker("eng");

    await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789</ ",
        tessedit_pageseg_mode: "6",
    });

    const { data: { text } } = await worker.recognize(imageUrl);
    await worker.terminate();

    console.log("  OCR complete.");
    return text;
}

// ---------------------------------------------------------------------------
// Step 3: MRZ Parser (TD3 — Passport)
// ---------------------------------------------------------------------------
function parseMRZ(ocrText) {
    const allLines = ocrText.split("\n").map(l => l.trim().replace(/\s/g, ""));
    const mrzPattern = /^[A-Z0-9<]{30,50}$/;
    const candidates = allLines.filter(l => mrzPattern.test(l));

    if (candidates.length < 2) {
        throw new Error(
            `MRZ not found. ${candidates.length} candidate line(s). OCR text:\n${ocrText}`
        );
    }

    const line1 = candidates[candidates.length - 2].padEnd(44, "<");
    const line2 = candidates[candidates.length - 1].padEnd(44, "<");

    console.log(`  MRZ L1: ${line1}`);
    console.log(`  MRZ L2: ${line2}`);

    // Line 1: Names
    const nameSection = line1.substring(5);
    const nameParts = nameSection.split("<<");
    const lastName = (nameParts[0] || "").replace(/</g, " ").trim();
    const firstName = (nameParts.slice(1).join(" ") || "").replace(/</g, " ").trim();

    // Line 2: Data
    const passportNumber = line2.substring(0, 9).replace(/</g, "").trim();
    const dobRaw = line2.substring(13, 19);
    const gender = line2.substring(20, 21);
    const expiryRaw = line2.substring(21, 27);
    const personalNumber = line2.substring(28, 42).replace(/</g, "").trim();

    function yymmddToDate(raw) {
        if (!raw || raw.length !== 6 || raw.includes("<")) return "";
        const yy = parseInt(raw.substring(0, 2), 10);
        const mm = raw.substring(2, 4);
        const dd = raw.substring(4, 6);
        const yyyy = yy > 50 ? `19${raw.substring(0, 2)}` : `20${raw.substring(0, 2)}`;
        return `${dd}/${mm}/${yyyy}`;
    }

    return {
        first_name: firstName,
        last_name: lastName,
        gender: gender === "M" ? "E" : gender === "F" ? "K" : gender,
        passport_number: passportNumber,
        national_id_number: personalNumber,
        date_of_birth: yymmddToDate(dobRaw),
        date_of_expiry: yymmddToDate(expiryRaw),
    };
}

// ---------------------------------------------------------------------------
// Step 4: Update Monday item
// ---------------------------------------------------------------------------
async function updateItem(boardId, itemId, data) {
    function toISO(ddmmyyyy) {
        if (!ddmmyyyy || ddmmyyyy.length !== 10) return null;
        const [dd, mm, yyyy] = ddmmyyyy.split("/");
        return dd && mm && yyyy ? `${yyyy}-${mm}-${dd}` : null;
    }

    const cv = {};
    ["first_name", "last_name", "gender", "passport_number", "national_id_number"]
        .forEach(f => { if (COLUMN_MAP[f] && data[f]) cv[COLUMN_MAP[f]] = data[f]; });

    ["date_of_birth", "date_of_expiry"].forEach(f => {
        const iso = toISO(data[f]);
        if (COLUMN_MAP[f] && iso) cv[COLUMN_MAP[f]] = { date: iso };
    });

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

        const imageUrl = await getImageUrl(itemId);
        console.log("  Image URL obtained");

        const ocrText = await ocrImage(imageUrl);
        console.log(`  OCR text: ${ocrText.length} chars`);

        const passportData = parseMRZ(ocrText);
        console.log("  Extracted:", JSON.stringify(passportData));

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
    res.json({ status: "ok", service: "monday-passport-ocr" });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Passport OCR server running on port ${PORT}`);
});
