// Techfix AI Chat — server-side proxy to Gemini.
//
// The Gemini API key must live ONLY here, as a Vercel environment variable —
// never in index.html or any other client-side file. Set it up at:
//   Vercel Dashboard -> your project -> Settings -> Environment Variables
//   Name:  GEMINI_API_KEY
//   Value: (your key)
// Then redeploy so the function can see it.

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_TURNS = 12; // keep the payload reasonable

// Very simple in-memory rate limiting per Vercel function instance. This is
// NOT robust against distributed abuse (each cold-started instance starts
// fresh) — see the note in the chat response about adding real auth-gating
// if this gets abused.
const requestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 15;

function isRateLimited(key) {
    const now = Date.now();
    const timestamps = (requestLog.get(key) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    timestamps.push(now);
    requestLog.set(key, timestamps);
    return timestamps.length > RATE_LIMIT_MAX;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        res.status(500).json({ error: 'Server is not configured (missing GEMINI_API_KEY).' });
        return;
    }

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
        res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
        return;
    }

    const { message, history } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
        res.status(400).json({ error: 'Message is required.' });
        return;
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
        res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).` });
        return;
    }

    const safeHistory = Array.isArray(history)
        ? history.slice(-MAX_HISTORY_TURNS).filter(h => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string')
        : [];

    const contents = [
        ...safeHistory.map(h => ({ role: h.role, parts: [{ text: h.text.slice(0, MAX_MESSAGE_LENGTH) }] })),
        { role: 'user', parts: [{ text: message }] }
    ];

    try {
        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents,
                    systemInstruction: {
                        parts: [{ text: 'You are Techfix AI, a helpful assistant inside the Techfix community forum, a tech repair and troubleshooting community. Keep answers concise and practical, formatted for a chat widget.' }]
                    },
                    generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
                })
            }
        );

        const data = await geminiRes.json();

        if (!geminiRes.ok) {
            console.error('Gemini API error:', data);
            res.status(geminiRes.status).json({ error: data.error?.message || 'Gemini API error.' });
            return;
        }

        const reply = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || "Sorry, I couldn't generate a response.";
        res.status(200).json({ reply });
    } catch (err) {
        console.error('Techfix AI proxy error:', err);
        res.status(500).json({ error: 'Something went wrong reaching Techfix AI. Please try again.' });
    }
};
