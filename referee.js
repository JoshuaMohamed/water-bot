const { GoogleGenerativeAI } = require("@google/generative-ai");
const { buildVisionPrompt } = require("./content");
const { config } = require("./config");
const logger = require("./logger");

const modelCache = new Map();

function getModelFor(modelName) {
  if (modelCache.has(modelName)) return modelCache.get(modelName);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: "application/json" },
  });
  modelCache.set(modelName, model);
  return model;
}

function clearModelCache() {
  modelCache.clear();
}

function getModelChain() {
  const chain = [config.geminiModel, ...(config.geminiFallbackModels || [])]
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  return [...new Set(chain)];
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

function errorText(error) {
  return (
    error?.stack || error?.message || String(error || "") || ""
  ).toString();
}

// Fail fast across models on transient errors; fail immediately (no
// fallback) on auth/config errors where another model can't help.
function isAuthError(error) {
  const text = errorText(error);
  return (
    /\[401\b|\b401 Unauthorized|\[403\b|\b403 Forbidden|\bAPI key not valid\b|\bAPI_KEY_INVALID\b/i.test(
      text,
    )
  );
}

function isRetryableError(error) {
  const text = errorText(error);
  return (
    /\[503\b|\[429\b|\[500\b|\[502\b|\[504\b|overloaded|high demand|Service Unavailable|Too Many Requests|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|aborted|abort|timeout|Timeout/i.test(
      text,
    ) ||
    error?.name === "AbortError" ||
    // Undici wraps timeouts/aborts in a generic Error whose cause is AbortError.
    error?.cause?.name === "AbortError"
  );
}

function isModelNotFoundError(error) {
  return /\[404\b|models\/.*not found|is not found for API version/i.test(
    errorText(error),
  );
}

// Race the SDK call against a timeout so an overloaded model or hung
// socket can't delay the bot reply for minutes. The SDK also gets the
// native `timeout` requestOption (>=0.16.0) so the HTTP request itself is
// aborted; the outer race covers older SDKs that ignore it.
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `${label} timed out after ${ms}ms (fail-fast)`,
      );
      error.name = "TimeoutError";
      reject(error);
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).then(
    (value) => {
      clearTimeout(timer);
      return value;
    },
    (error) => {
      clearTimeout(timer);
      throw error;
    },
  );
}

async function tryModelOnce(modelName, imagePart, prompt, timeoutMs) {
  const startedAt = Date.now();
  try {
    const model = getModelFor(modelName);
    const call = model.generateContent([prompt, imagePart], {
      timeout: timeoutMs,
    });
    const result = await withTimeout(
      call,
      timeoutMs,
      `Gemini model ${modelName}`,
    );
    const response = await result.response;
    return {
      ok: true,
      text: response.text(),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return { ok: false, error, latencyMs: Date.now() - startedAt };
  }
}

async function inspectWaterPhoto(
  imageBuffer,
  mimeType,
  userName,
  currentLogCount,
) {
  const chain = getModelChain();
  if (chain.length === 0) {
    logger.error("Gemini Vision: no model configured");
    return rejectedResult(
      `Couldn't verify that photo right now, ${userName} — please try again in a bit.`,
    );
  }

  const timeoutMs = config.geminiTimeoutMs;
  const imagePart = bufferToGenerativePart(imageBuffer, mimeType);
  const prompt = buildVisionPrompt(userName, currentLogCount);
  let lastError = null;
  let sawOverload = false;

  for (let index = 0; index < chain.length; index++) {
    const modelName = chain[index];
    const outcome = await tryModelOnce(modelName, imagePart, prompt, timeoutMs);

    if (outcome.ok) {
      try {
        const parsed = JSON.parse(outcome.text);
        const evaluation = normalizeEvaluation(
          parsed,
          userName,
          currentLogCount,
        );
        if (evaluation) {
          logger.info(
            `Gemini Vision ok via ${modelName} in ${outcome.latencyMs}ms`,
          );
          return evaluation;
        }
        logger.warn(
          `Gemini Vision via ${modelName}: invalid JSON shape, not retrying fallback`,
        );
        return rejectedResult(
          `Couldn't verify that photo, ${userName} — please re-send a clear shot of the container.`,
        );
      } catch (parseError) {
        logger.warn(
          `Gemini Vision via ${modelName}: JSON parse failed:`,
          parseError?.stack || parseError?.message || parseError,
        );
        return rejectedResult(
          `Couldn't verify that photo, ${userName} — please re-send a clear shot of the container.`,
        );
      }
    }

    lastError = outcome.error;
    const failedIn = `${outcome.latencyMs}ms`;

    if (isAuthError(outcome.error)) {
      logger.error(
        `Gemini Vision API Error via ${modelName} after ${failedIn} (auth/config, no fallback):`,
        errorText(outcome.error),
      );
      break;
    }

    const canFallback =
      index < chain.length - 1 &&
      (isRetryableError(outcome.error) ||
        isModelNotFoundError(outcome.error));
    if (isRetryableError(outcome.error)) sawOverload = true;
    if (isModelNotFoundError(outcome.error)) sawOverload = true;

    logger.warn(
      `Gemini Vision via ${modelName} failed after ${failedIn}${canFallback ? `, trying fallback ${chain[index + 1]}` : ", no more models"}:`,
      errorText(outcome.error).slice(0, 500),
    );

    if (!canFallback) break;
  }

  logger.error(
    "Gemini Vision API Error:",
    errorText(lastError).slice(0, 1000) || lastError,
  );
  // Fail closed: never auto-grant points when verification is unavailable.
  // Overload-specific copy so users retry promptly instead of waiting on a
  // late analysis; still rejected so !override can grant the point.
  if (sawOverload) {
    return rejectedResult(
      `⚠️ Gemini is overloaded right now, ${userName} — I didn't count this one. Please re-send it in a minute!`,
    );
  }
  return rejectedResult(
    `Couldn't verify that photo right now, ${userName} — please try again in a bit.`,
  );
}

module.exports = {
  inspectWaterPhoto,
  // Exported for tests.
  getModelChain,
  isRetryableError,
  isAuthError,
  isModelNotFoundError,
  clearModelCache,
};
