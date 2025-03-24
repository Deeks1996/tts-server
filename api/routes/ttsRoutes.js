import express from "express";
import multer from "multer";
import axios from "axios";
import supabase from "../config/supabaseClient.js";
import dotenv from 'dotenv';
import { PDFDocument } from "pdf-lib";
import mammoth from "mammoth";
import csvParser from "csv-parser";
import { Readable } from "stream";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

dotenv.config();

// Middleware to Verify Supabase Auth Token
const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized: No token provided" });

    console.log("Token:", token);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Unauthorized: Invalid token" });

    req.user = data.user;
    next();
};

// Function to Extract Text from Different File Types
const extractTextFromFile = async (file) => {
    if (!file) return null;

    const { mimetype, buffer, originalname } = file;
    const fileExt = originalname.split(".").pop().toLowerCase();

    try {
        if (mimetype === "text/plain" || fileExt === "md") {
            return buffer.toString("utf-8"); // Plain text & Markdown
        } else if (mimetype === "application/pdf") {
            // Use pdf-lib to extract text
            const pdfDoc = await PDFDocument.load(buffer);
            const pages = pdfDoc.getPages().map((page) => page.getTextContent());
            const text = (await Promise.all(pages))
                .map((content) => content.items.map((item) => item.str).join(" "))
                .join("\n");
            return text || "No text found in PDF.";
        } else if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
            const { value } = await mammoth.extractRawText({ buffer });
            return value;
        } else if (mimetype === "text/csv") {
            return new Promise((resolve, reject) => {
                let text = "";
                const stream = Readable.from(buffer);
                stream.pipe(csvParser())
                    .on("data", (row) => text += Object.values(row).join(" ") + " ")
                    .on("end", () => resolve(text.trim()))
                    .on("error", (err) => reject(err));
            });
        } else {
            throw new Error("Unsupported file format");
        }
    } catch (error) {
        console.error("Error extracting text:", error);
        return null;
    }
};

// Convert Text to Speech and Store in Database
router.post("/convert", verifyToken, upload.single("file"), async (req, res) => {
    const { text } = req.body;
    const userId = req.user.id;
    let inputText = text;

    console.log("Uploaded file:", req.file);
    
    if (req.file) {
        inputText = await extractTextFromFile(req.file);
        if (!inputText) return res.status(400).json({ error: "Failed to extract text from file." });
    }

    if (!inputText || inputText.length > 2000) {
        return res.status(400).json({ error: "Invalid input or text exceeds 2000 characters." });
    }

    try {
        // Deepgram API Request
        const response = await axios.post(
            "https://api.deepgram.com/v1/speak",
            { text: inputText },
            { 
                headers: { 
                    "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
                    "Content-Type": "application/json"
                }, 
                responseType: "arraybuffer"
            }
        );

        if (!response.data) {
            return res.status(500).json({ error: "Deepgram API response is empty." });
        }

        const audioBuffer = Buffer.from(response.data);
        if (!audioBuffer || audioBuffer.length === 0) {
            return res.status(500).json({ error: "Failed to generate audio." });
        }

        const audioPath = `tts_audio/${Date.now()}.mp3`;

        const { error: uploadError } = await supabase.storage.from("ttsaudio").upload(audioPath, audioBuffer, {
            contentType: "audio/mpeg"
        });

        if (uploadError) {
            console.error("Supabase Upload Error:", uploadError);
            return res.status(500).json({ error: uploadError.message });
        }

        const audioUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/ttsaudio/${audioPath}`;

        // Insert Data into Database
        const { error: dbError } = await supabase.from("tts_database").insert([
            { user_id: userId, text: inputText, audio_url: audioUrl, created_at: new Date() }
        ]);

        if (dbError) {
            console.error("Database Insert Error:", dbError);
            return res.status(500).json({ error: dbError.message });
        }

        return res.status(200).json({ message: "TTS conversion successful", audioUrl });
    } catch (error) {
        console.error("Deepgram API Error:", error);
        return res.status(500).json({ error: "TTS conversion failed.", details: error.message });
    }
});

export default router;
