const { GoogleGenerativeAI } = require("@google/generative-ai");
const { buildVisionPrompt } = require("./content");
const logger = require("./logger");

const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

let cachedModel = null;

function getModel() {
  if (cachedModel) return cachedModel;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  cachedModel = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { responseMimeType: "application/json" },
  });
  return cachedModel;
}

function bufferToGenerativePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType,
    },
  };
}

function normalizeEvaluation(parsed, userName, currentLogCount) {
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.isValid !== "boolean") return null;
  if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
    parsed.reason =
      parsed.isValid === true
        ? `Log #${currentLogCount + 1} counted for ${userName}.`
        : `Couldn't verify a drink container in that photo, ${userName}.`;
  }
  return { isValid: parsed.isValid, reason: parsed.reason };
}

function rejectedResult(reason) {
  return { isValid: false, reason };
}

async function inspectWaterPhoto(
  imageBuffer,
  mimeType,
  userName,
  currentLogCount,
) {
  try {
    const imagePart = bufferToGenerativePart(imageBuffer, mimeType);
    const result = await getModel().generateContent([
      buildVisionPrompt(userName, currentLogCount),
      imagePart,
    ]);
    const response = await result.response;
    const parsed = JSON.parse(response.text());
    return (
      normalizeEvaluation(parsed, userName, currentLogCount) ||
      rejectedResult(
        `Couldn't verify that photo, ${userName} — please re-send a clear shot of the container.`,
      )
    );
  } catch (error) {
    logger.error("Gemini Vision API Error:", error.message || error);
    // Fail closed: never auto-grant points when verification is unavailable.
    return rejectedResult(
      `Couldn't verify that photo right now, ${userName} — please try again in a bit.`,
    );
  }
}

module.exports = { inspectWaterPhoto };
