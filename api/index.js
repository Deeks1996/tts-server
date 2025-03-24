import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/authRoutes.js";
import ttsRoutes from "./routes/ttsRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());
app.use("/auth", authRoutes);
app.use("/tts", ttsRoutes);

app.get("/", (req, res) => {
  res.send("Welcome to the TTS API!");
});

export default app;