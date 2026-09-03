const { GoogleGenerativeAI } = require("@google/generative-ai");
const { buildVisionPrompt } = require("./content");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-3.5-flash-lite",
  generationConfig: { responseMimeType: "application/json" },
});

function bufferToGenerativePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString("base64"),
      mimeType,
    },
  };
}

async function inspectWaterPhoto(
  imageBuffer,
  mimeType,
  userName,
  currentLogCount,
) {
  try {
    const imagePart = bufferToGenerativePart(imageBuffer, mimeType);
    const result = await model.generateContent([
      buildVisionPrompt(userName, currentLogCount),
      imagePart,
    ]);
    const response = await result.response;
    return JSON.parse(response.text());
  } catch (error) {
    console.error("Gemini Vision API Error:", error);
    // Fallback if API fails
    return {
      isValid: true,
      reason: `👍 Log #${currentLogCount + 1} logged for ${userName}! (Vision check skipped due to connection glitch)`,
    };
  }
}

module.exports = { inspectWaterPhoto };
