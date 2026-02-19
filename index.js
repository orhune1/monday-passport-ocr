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
// Step 2: Tesseract OCR (two passes for better accuracy)
// ---------------------------------------------------------------------------
async function ocrImage(imageUrl) {
    console.log("  Running Tesseract OCR...");
    // Pass 1: MRZ-optimized (only MRZ valid chars)
    const worker = await Tesseract.createWorker("eng");
    await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
        tessedit_pageseg_mode: "6",
    });
    const { data: { text } } = await worker.recognize(imageUrl);
    await worker.terminate();
    console.log("  OCR complete.");
    console.log("  Raw OCR text:", JSON.stringify(text));
    return text;
}
// ---------------------------------------------------------------------------
// Step 3: MRZ Parser with OCR error correction
// ---------------------------------------------------------------------------
// Common OCR misreads: these letters often get confused
function fixMRZChar(ch, expectDigit) {
    if (expectDigit) {
        // In digit positions, fix letter→digit misreads
        const digitFixes = {
            'O': '0', 'Q': '0', 'D': '0',
            'I': '1', 'L': '1', 'l': '1',
            'Z': '2', 'z': '2',
            'E': '3',
            'A': '4', 'H': '4',
            'S': '5',
            'G': '6', 'b': '6',
            'T': '7',
            'B': '8',
            'g': '9', 'q': '9',
        };
        return digitFixes[ch] || ch;
    }
    return ch;
}
// Clean up filler characters: in MRZ, consecutive non-name chars are likely '<'
function cleanMRZLine1(raw) {
    // Line 1 format: P<CCCSURNAME<<GIVENNAMES<<<<<<<<<<<<<<<<<
    // First 5 chars: P + filler + 3-letter country code
    // After names, everything should be '<' filler
    let line = raw.padEnd(44, "<");
    // Fix position 1: should be '<'
    if (line[1] !== '<') {
        line = line[0] + '<' + line.substring(2);
    }
    // After finding the name region, replace trailing non-alpha with '<'
    // Find where names end (look for 3+ consecutive non-standard chars)
    const nameEnd = findNameEnd(line.substring(5));
    if (nameEnd > 0) {
        const namesPart = line.substring(5, 5 + nameEnd);
        const fillerPart = '<'.repeat(44 - 5 - nameEnd);
        line = line.substring(0, 5) + namesPart + fillerPart;
    }
    return line;
}
function findNameEnd(nameSection) {
    // Find where actual name characters end
    // Names contain A-Z and '<', filler is all '<'
    // Look for the last actual letter
    let lastLetterPos = 0;
    for (let i = 0; i < nameSection.length; i++) {
        if (/[A-Z]/.test(nameSection[i])) {
            lastLetterPos = i + 1;
        }
    }
    return lastLetterPos;
}
function cleanMRZLine2(raw) {
    // Line 2 format (44 chars):
    // Pos 0-8:   Passport number (alphanum)
    // Pos 9:     Check digit (digit)
    // Pos 10-12: Nationality (letters, e.g. TUR)
    // Pos 13-18: DOB YYMMDD (digits)
    // Pos 19:    Check digit (digit)
    // Pos 20:    Gender M/F/<
    // Pos 21-26: Expiry YYMMDD (digits)
    // Pos 27:    Check digit (digit)
    // Pos 28-41: Personal number (alphanum)
    // Pos 42:    Check digit (digit)
    // Pos 43:    Overall check digit (digit)
    let line = raw.padEnd(44, "<");
    let chars = line.split("");
    // Fix digit positions
    const digitPositions = [9, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 42, 43];
    for (const pos of digitPositions) {
        if (pos < chars.length && !/[0-9]/.test(chars[pos])) {
            chars[pos] = fixMRZChar(chars[pos], true);
        }
    }
    // Fix nationality (positions 10-12) — should be letters
    // For Turkish passports, it's always "TUR"
    const nat = chars.slice(10, 13).join("");
    if (nat !== "TUR") {
        // Try to detect if it looks like TUR with misreads
        if (/^[T7][UVW][R8]$/i.test(nat)) {
            chars[10] = 'T'; chars[11] = 'U'; chars[12] = 'R';
        }
    }
    // Fix gender (position 20) — should be M, F, or <
    if (!['M', 'F', '<'].includes(chars[20])) {
        // Common misreads for M
        if (['W', 'N', 'H'].includes(chars[20])) chars[20] = 'M';
    }
    return chars.join("");
}
function parseMRZ(ocrText) {
    const allLines = ocrText.split("\n").map(l => l.trim().replace(/\s/g, ""));
    // MRZ lines: 30-50 chars, mostly uppercase + digits + <
    // Be more lenient: allow some lowercase and common misread chars
    const candidates = allLines.filter(l => {
        if (l.length < 28) return false;
        const mrzChars = l.replace(/[^A-Z0-9<]/gi, "").length;
        return mrzChars / l.length > 0.85;
    });
    if (candidates.length < 2) {
        throw new Error(
            `MRZ not found. ${candidates.length} candidate(s). OCR:\n${ocrText}`
        );
    }
    // Take last 2 (MRZ is at the bottom)
    let line1raw = candidates[candidates.length - 2].toUpperCase().replace(/[^A-Z0-9<]/g, "");
    let line2raw = candidates[candidates.length - 1].toUpperCase().replace(/[^A-Z0-9<]/g, "");
    console.log(`  MRZ raw L1: ${line1raw}`);
    console.log(`  MRZ raw L2: ${line2raw}`);
    // Apply OCR corrections
    const line1 = cleanMRZLine1(line1raw);
    const line2 = cleanMRZLine2(line2raw);
    console.log(`  MRZ fix L1: ${line1}`);
    console.log(`  MRZ fix L2: ${line2}`);
    // --- Parse Line 1: Names ---
    const nameSection = line1.substring(5);
    // Replace common OCR misreads of '<' in name section
    // First, find the name separator '<<' — might be misread as 'CC', 'LL', 'II', etc.
    let cleanedNames = nameSection;
    // Replace sequences of non-alpha filler chars with '<'
    cleanedNames = cleanedNames.replace(/[^A-Z]{2,}/g, match => '<'.repeat(match.length));
    // Also handle single filler chars between name parts
    cleanedNames = cleanedNames.replace(/([A-Z])([^A-Z])([A-Z])/g, '$1<$3');
    const nameParts = cleanedNames.split(/<<+/);
    const lastName = (nameParts[0] || "").replace(/</g, " ").replace(/[^A-Z ]/g, "").trim();
    const firstName = (nameParts.slice(1).join(" ") || "").replace(/</g, " ").replace(/[^A-Z ]/g, "").trim();
    // --- Parse Line 2: Data ---
    const passportNumber = line2.substring(0, 9).replace(/</g, "").trim();
    const dobRaw = line2.substring(13, 19);
    const gender = line2.substring(20, 21);
    const expiryRaw = line2.substring(21, 27);
    const personalNumber = line2.substring(28, 42).replace(/</g, "").trim();
    function yymmddToDate(raw) {
        if (!raw || raw.length !== 6) return "";
        // Make sure all chars are digits
        const cleaned = raw.replace(/[^0-9]/g, "");
        if (cleaned.length !== 6) return "";
        const yy = parseInt(cleaned.substring(0, 2), 10);
        const mm = parseInt(cleaned.substring(2, 4), 10);
        const dd = parseInt(cleaned.substring(4, 6), 10);
        // Validate ranges
        if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "";
        const yyyy = yy > 50 ? 1900 + yy : 2000 + yy;
        const mmStr = String(mm).padStart(2, '0');
        const ddStr = String(dd).padStart(2, '0');
        return `${ddStr}/${mmStr}/${yyyy}`;
    }
    const genderText = gender === "M" ? "E" : gender === "F" ? "K" : gender;
    const result = {
        first_name: firstName,
        last_name: lastName,
        gender: genderText,
        passport_number: passportNumber,
        national_id_number: personalNumber,
        date_of_birth: yymmddToDate(dobRaw),
        date_of_expiry: yymmddToDate(expiryRaw),
    };
    return result;
}
// ---------------------------------------------------------------------------
// Step 4: Update Monday item (with date validation)
// ---------------------------------------------------------------------------
async function updateItem(boardId, itemId, data) {
    function toISO(ddmmyyyy) {
        if (!ddmmyyyy || ddmmyyyy.length !== 10) return null;
        const parts = ddmmyyyy.split("/");
        if (parts.length !== 3) return null;
        const [dd, mm, yyyy] = parts;
        // Validate it's all digits
        if (!/^\d{2}$/.test(dd) || !/^\d{2}$/.test(mm) || !/^\d{4}$/.test(yyyy)) return null;
        const d = parseInt(dd), m = parseInt(mm), y = parseInt(yyyy);
        if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
        return `${yyyy}-${mm}-${dd}`;
    }
    const cv = {};
    ["first_name", "last_name", "gender", "passport_number", "national_id_number"]
        .forEach(f => { if (COLUMN_MAP[f] && data[f]) cv[COLUMN_MAP[f]] = data[f]; });
    ["date_of_birth", "date_of_expiry"].forEach(f => {
        const iso = toISO(data[f]);
        if (COLUMN_MAP[f] && iso) {
            cv[COLUMN_MAP[f]] = { date: iso };
        } else {
            console.log(`  Skipping invalid date for ${f}: "${data[f]}"`);
        }
    });
    if (Object.keys(cv).length === 0) {
        throw new Error("No valid data to update.");
    }
    console.log("  Column values:", JSON.stringify(cv));
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
