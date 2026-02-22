import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" })); // Large limit because screenshots are base64

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ============================================================
   POST /api/explain
   Purpose:
     Analyze a screenshot and return structured information.

   Body:
     {
       imageDataUrl: "data:image/png;base64,...",
       instruction?: string
     }

   Response:
     {
       category: string,
       confidence: number,
       summary: string,
       followups: string[]
     }
============================================================ */
app.post("/api/explain", async (req, res) => {
  try {
    const { imageDataUrl, instruction } = req.body || {};

    if (!imageDataUrl || typeof imageDataUrl !== "string") {
      return res.status(400).json({ error: "imageDataUrl is required" });
    }

    if (!imageDataUrl.startsWith("data:image/")) {
      return res.status(400).json({
        error: "imageDataUrl must be a valid base64 data URL (e.g. data:image/png;base64,...)",
      });
    }

    const userInstruction = (instruction || "").toString().trim();

    const systemPrompt =
      `You are an intelligent screen analysis assistant.\n\n` +
      `Your task:\n` +
      `1. Identify what type of task or domain the screenshot represents.\n` +
      `2. Provide a clear and useful explanation.\n` +
      `3. If information is insufficient, provide at most 3 essential follow-up questions.\n\n` +
      `Category must be one of:\n` +
      `[math, code, writing, translation, finance, science, general]\n\n` +
      `Output must strictly follow the JSON schema.`;

    const extraInstruction =
      userInstruction.length > 0
        ? `\n\nAdditional user instruction:\n${userInstruction}`
        : "";

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: systemPrompt + extraInstruction },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ScreenAssistResponse",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              category: { type: "string" },
              confidence: { type: "number" },
              summary: { type: "string" },
              followups: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: [
              "category",
              "confidence",
              "summary",
              "followups",
            ],
          },
        },
      },
    });

    const jsonText = response.output_text;

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return res.status(502).json({
        error: "Model did not return valid JSON",
        raw: jsonText,
      });
    }

    return res.json(parsed);
  } catch (error) {
    console.error("Error in /api/explain:", error);
    return res.status(500).json({
      error: error?.message || "Internal server error",
    });
  }
});

/* ============================================================
   POST /api/chat
   Purpose:
     Continue a learning session with conversational memory.

   Body:
     {
       context: string,
       question: string,
       history?: [{ role: "user"|"assistant", text: string }]
     }

   Response:
     {
       answer: string,
       followups: string[]
     }
============================================================ */
app.post("/api/chat", async (req, res) => {
  try {
    const { context, question, history } = req.body || {};

    if (!context || typeof context !== "string") {
      return res.status(400).json({ error: "context is required" });
    }

    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "question is required" });
    }

    const safeHistory = Array.isArray(history) ? history : [];

    // Keep only last 30 turns for token safety
    const turns = safeHistory.slice(-30).map((m) => ({
      role: m?.role === "assistant" ? "assistant" : "user",
      content: String(m?.text || ""),
    }));

    const systemPrompt =
      `You are a helpful general-purpose assistant.\n\n` +
      `You will receive:\n` +
      `- Recognized material from a screenshot\n` +
      `- Conversation history\n\n` +
      `Requirements:\n` +
      `- Maintain conversational continuity.\n` +
      `- Build upon previous answers instead of restarting.\n` +
      `- Use the screenshot material when relevant.\n` +
      `- If the user's question is unrelated to the screenshot, answer it normally as a general assistant.\n` +
      `- If information is insufficient, say what is missing and provide at most 2 follow-up questions.\n\n` +
      `[Screenshot Material]\n${context}\n`;

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      instructions: systemPrompt,
      input: [...turns, { role: "user", content: question }],
      text: {
        format: {
          type: "json_schema",
          name: "ChatResponse",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              answer: { type: "string" },
              followups: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["answer", "followups"],
          },
        },
      },
    });

    const jsonText = response.output_text;

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return res.status(502).json({
        error: "Model did not return valid JSON",
        raw: jsonText,
      });
    }

    return res.json(parsed);
  } catch (error) {
    console.error("Error in /api/chat:", error);
    return res.status(500).json({
      error: error?.message || "Internal server error",
    });
  }
});

/* ============================================================ */

app.listen(3001, () => {
  console.log("API server running at http://localhost:3001");
});
