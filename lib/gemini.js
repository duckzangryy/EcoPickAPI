/**
 * Module tích hợp Google Gemini AI để thẩm định và chấm điểm rác thải qua ảnh.
 * Hỗ trợ đa API Key tự động xoay tua (failover/round-robin) khi một key hết hạn mức (429/quota).
 */
const SEVERITY_COLORS = {
  green: '#10B981',  // Mức nhẹ / Không có rác (0 - 10 điểm)
  yellow: '#F59E0B', // Mức trung bình (25 điểm)
  red: '#EF4444',    // Mức nghiêm trọng (50 điểm)
};

const POINTS_BY_SEVERITY = {
  none: 0,
  low: 10,
  medium: 25,
  high: 50,
  critical: 50,
};

let currentKeyIndex = 0;

/**
 * Lấy danh sách API keys theo thứ tự ưu tiên:
 * 1. GEMINI_API_KEY_PRO (tài khoản Pro)
 * 2. GEMINI_API_KEY_PRIMARY / GEMINI_API_KEY
 * 3. GEMINI_API_KEY_PLUS (tài khoản Plus)
 * 4. GEMINI_API_KEY_SECONDARY / GEMINI_API_KEY_BACKUP
 * 5. Hoặc danh sách trong GEMINI_API_KEYS (phân tách bởi dấu phẩy)
 */
function getApiKeys() {
  const keys = [];

  // Key Pro ưu tiên trước
  const priorityList = [
    process.env.GEMINI_API_KEY_PRO,
    process.env.GEMINI_API_KEY_PRIMARY,
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_PLUS,
    process.env.GEMINI_API_KEY_SECONDARY,
    process.env.GEMINI_API_KEY_BACKUP,
  ];

  for (const k of priorityList) {
    if (k && typeof k === 'string' && k.trim() && !keys.includes(k.trim())) {
      keys.push(k.trim());
    }
  }

  // Bổ sung các key từ chuỗi phân cách dấu phẩy nếu có
  if (process.env.GEMINI_API_KEYS) {
    const splitted = process.env.GEMINI_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
    for (const k of splitted) {
      if (!keys.includes(k)) keys.push(k);
    }
  }

  return keys;
}

/**
 * Gửi yêu cầu tới Google Gemini API với một key cụ thể
 */
async function callGeminiWithKey(apiKey, model, requestBody) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      const isQuotaError =
        res.status === 429 ||
        res.status === 403 ||
        errText.includes('RESOURCE_EXHAUSTED') ||
        errText.includes('quota') ||
        errText.includes('RATE_LIMIT');
      return { ok: false, status: res.status, errorText: errText, isQuotaError };
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return { ok: false, status: 200, errorText: 'Phản hồi rỗng từ Gemini API', isQuotaError: false };
    }

    return { ok: true, rawText };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, status: 0, errorText: err?.message || String(err), isQuotaError: false };
  }
}

/**
 * Phân tích ảnh Buffer hoặc Base64 bằng Gemini Vision
 * @param {Buffer} imageBuffer - Buffer ảnh
 * @param {string} mimeType - mime type của ảnh (vd: image/jpeg)
 * @returns {Promise<{
 *   has_waste: boolean,
 *   severity: 'none'|'low'|'medium'|'high'|'critical',
 *   waste_types: string[],
 *   points: number,
 *   confidence: number,
 *   reason: string
 * } | null>}
 */
async function analyzeWasteImage(imageBuffer, mimeType = 'image/jpeg') {
  const keys = getApiKeys();
  if (keys.length === 0) {
    console.warn('[Gemini AI] Chưa cấu hình API key (GEMINI_API_KEY_PRO / GEMINI_API_KEY_PLUS)');
    return null;
  }

  let cleanBuffer = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer);
  while (cleanBuffer.length > 2 && (cleanBuffer[0] === 0x0d || cleanBuffer[0] === 0x0a || cleanBuffer[0] === 0x20)) {
    cleanBuffer = cleanBuffer.slice(1);
  }
  const base64Data = cleanBuffer.toString('base64');

  const prompt = `Bạn là hệ thống AI giám định rác thải của ứng dụng bảo vệ môi trường EcoPick.
Nhiệm vụ: Phân tích ảnh hiện trường để xếp hạng mức độ nghiêm trọng gồm đúng 3 màu và số điểm tương ứng:

QUY TẮC MÀU & ĐIỂM:
1. KHÔNG CÓ RÁC (0 điểm) - MÀU ĐỎ CẢNH BÁO ("#EF4444"):
   - 0 điểm: Ảnh KHÔNG chứa rác thải vứt bừa bãi ngoài môi trường (ảnh selfie, phong cảnh sạch sẽ, đồ vật trong nhà, thú cưng, xe cộ, phòng ốc...).
2. MÀU XANH LÁ ("#10B981") - Mức Nhẹ (10 điểm):
   - 10 điểm: Chỉ có 1-3 mẩu rác nhỏ lẻ (vỏ chai, bao nilon nhỏ).
3. MÀU VÀNG CAM ("#F59E0B") - Mức Trung Bình (25 điểm):
   - 25 điểm: Đống rác vừa, nhiều bao nilon, chai lọ rải rác bên lề đường, công viên, bãi biển.
4. MÀU ĐỎ ("#EF4444") - Mức Nghiêm Trọng (50 điểm):
   - 50 điểm: Bãi rác lớn, điểm nóng ô nhiễm môi trường, bãi rác tự phát tràn đường, rác công nghiệp độc hại, rác làm tắc cống rãnh sông suối.

CHỈ TRẢ VỀ DUY NHẤT ĐỊNH DẠNG JSON SAU:
{
  "points": 25,
  "color": "#F59E0B",
  "reason": "1 câu giải thích ngắn gọn dưới 15 từ"
}`;

  const candidateModels = [
    process.env.GEMINI_MODEL,
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-3.8-flash',
  ].filter((m, i, arr) => m && arr.indexOf(m) === i);

  const requestBody = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: base64Data,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 80,
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  };

  try {
    let successRawText = null;
    const totalKeys = keys.length;

    // Thử lần lượt các key và các model dự phòng
    outerLoop: for (const model of candidateModels) {
      for (let attempt = 0; attempt < totalKeys; attempt++) {
        const keyIdx = (currentKeyIndex + attempt) % totalKeys;
        const apiKey = keys[keyIdx];
        const masked = `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`;

        const result = await callGeminiWithKey(apiKey, model, requestBody);
        if (result.ok) {
          currentKeyIndex = keyIdx;
          successRawText = result.rawText;
          break outerLoop;
        }

        console.warn(`[Gemini AI] Model ${model} với Key #${keyIdx + 1} (${masked}) lỗi (${result.status}): ${result.errorText.slice(0, 120)}`);
        if (result.isQuotaError && totalKeys > 1) {
          console.warn(`[Gemini AI] Key #${keyIdx + 1} hết quota trên model ${model}. Đang thử key/model tiếp theo...`);
        }
      }
    }

    if (!successRawText) {
      console.error('[Gemini AI] Toàn bộ API keys đều không gọi được.');
      return null;
    }

    const parsed = JSON.parse(successRawText);
    let points = Number(parsed.points);
    if (!Number.isFinite(points) || points < 0) points = 0;
    if (points > 50) points = 50;

    // Chuẩn hoá nghiêm ngặt đúng 3 màu: Xanh lá, Vàng cam, Đỏ
    let color = '#10B981';
    let severity = 'low';

    if (points === 0) {
      color = '#EF4444';
      severity = 'none';
    } else if (points <= 15) {
      color = '#10B981';
      severity = 'low';
    } else if (points <= 35) {
      color = '#F59E0B';
      severity = 'medium';
    } else {
      color = '#EF4444';
      severity = 'high';
    }

    if (points > 0 && ['#10B981', '#F59E0B', '#EF4444'].includes(parsed.color)) {
      color = parsed.color;
    }

    const hasWaste = points > 0;
    return {
      points,
      color,
      severity,
      has_waste: hasWaste,
      waste_types: Array.isArray(parsed.waste_types) ? parsed.waste_types : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 1.0,
      reason: parsed.reason || (hasWaste ? `Phát hiện rác thải (+${points} điểm)` : 'Không có rác thải trong ảnh (0 điểm)'),
    };
  } catch (err) {
    console.error('[Gemini AI] Exception khi phân tích ảnh:', err);
    return null;
  }
}

module.exports = {
  SEVERITY_COLORS,
  POINTS_BY_SEVERITY,
  analyzeWasteImage,
};
