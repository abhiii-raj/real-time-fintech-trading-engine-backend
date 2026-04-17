require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const express = require("express");
const mongoose = require("mongoose");
const https = require("https");
const crypto = require("crypto");
const querystring = require("querystring");
const nodemailer = require("nodemailer");

const bodyParser = require("body-parser");
const cors = require("cors");

const { HoldingsModel } = require("./model/HoldingsModel");
const { PositionsModel } = require("./model/PositionsModel");

const PORT = process.env.PORT || 3002;
const uri = process.env.MONGO_URL;

const { OrdersModel } = require("./model/OrdersModel");
const { SupportQueryModel } = require("./model/SupportQueryModel");
const { UserModel } = require("./model/UserModel");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const app = express();

app.use(cors());
app.use(bodyParser.json());

const PAPER_PRICES = {
    INFY: 1555.45,
    ONGC: 116.8,
    TCS: 3194.8,
    KPITTECH: 266.45,
    QUICKHEAL: 308.55,
    WIPRO: 577.75,
    "M&M": 779.8,
    RELIANCE: 2112.4,
    HUL: 512.4,
    ITC: 207.9,
    SBIN: 430.2,
    TATAPOWER: 124.15,
    BHARTIARTL: 541.15,
    HDFCBANK: 1522.35,
    HINDUNILVR: 2417.4,
    SGBMAY29: 4719.0,
    EVEREADY: 312.35,
    JUBLFOOD: 3082.65
};

const SIMULATED_PRICE_STATE = { ...PAPER_PRICES };

const YAHOO_SYMBOL_OVERRIDES = {
    "M&M": "M&M.NS"
};

const TWELVEDATA_SYMBOL_OVERRIDES = {
    "M&M": "M&M:NSE"
};

const MARKET_DATA_PROVIDER = String(process.env.MARKET_DATA_PROVIDER || "twelvedata").toLowerCase();
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://real-time-fintech-trading-engine-da.vercel.app";
const BACKEND_URL = process.env.BACKEND_URL || "";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "";
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_REDIRECT_URI = String(
    process.env.GOOGLE_REDIRECT_URI
    || (BACKEND_URL ? new URL("/auth/google/callback", BACKEND_URL).toString() : "https://real-time-fintech-trading-engine-backend-5ao3.onrender.com/auth/google/callback")
).trim();

const normalizeSymbol = (symbol = "") => symbol.trim().toUpperCase();

const toYahooSymbol = (symbol = "") => {
    const normalized = normalizeSymbol(symbol);
    if (YAHOO_SYMBOL_OVERRIDES[normalized]) {
        return YAHOO_SYMBOL_OVERRIDES[normalized];
    }
    if (normalized.endsWith(".NS") || normalized.endsWith(".BO")) {
        return normalized;
    }
    return `${normalized}.NS`;
};

const toTwelveDataSymbol = (symbol = "") => {
    const normalized = normalizeSymbol(symbol);
    if (TWELVEDATA_SYMBOL_OVERRIDES[normalized]) {
        return TWELVEDATA_SYMBOL_OVERRIDES[normalized];
    }
    if (normalized.includes(":")) {
        return normalized;
    }
    return `${normalized}:NSE`;
};

const getPaperPrice = (symbol = "") => {
    const normalized = normalizeSymbol(symbol);
    return PAPER_PRICES[normalized];
};

const generateSimulatedTick = (symbol = "", referencePrice) => {
    const normalized = normalizeSymbol(symbol);
    const fallback = Number.isFinite(referencePrice) ? Number(referencePrice) : Number(PAPER_PRICES[normalized] || 100);
    const previous = Number(SIMULATED_PRICE_STATE[normalized]);
    const previousSafe = Number.isFinite(previous) && previous > 0 ? previous : fallback;

    // Small random walk to keep demo prices moving on each manual refresh.
    const volatility = previousSafe > 1000 ? 0.0025 : 0.0045;
    const drift = (Math.random() * 2 - 1) * volatility;
    const next = Number((previousSafe * (1 + drift)).toFixed(2));

    SIMULATED_PRICE_STATE[normalized] = next;

    const change = Number((next - previousSafe).toFixed(2));
    const changePercent = previousSafe > 0 ? Number(((change / previousSafe) * 100).toFixed(2)) : 0;

    return {
        lastPrice: next,
        change,
        changePercent
    };
};

const fetchYahooQuotes = (symbols) => {
    const yahooSymbols = symbols.map(toYahooSymbol).join(",");
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooSymbols)}`;

    return new Promise((resolve, reject) => {
        https.get(url, (resp) => {
            let raw = "";

            resp.on("data", (chunk) => {
                raw += chunk;
            });

            resp.on("end", () => {
                try {
                    const parsed = JSON.parse(raw);
                    resolve(parsed?.quoteResponse?.result || []);
                } catch (err) {
                    reject(err);
                }
            });
        }).on("error", (err) => {
            reject(err);
        });
    });
};

const fetchJsonByUrl = (url) => {
    return new Promise((resolve, reject) => {
        https.get(url, (resp) => {
            let raw = "";

            resp.on("data", (chunk) => {
                raw += chunk;
            });

            resp.on("end", () => {
                try {
                    const parsed = JSON.parse(raw);
                    resolve(parsed);
                } catch (err) {
                    reject(err);
                }
            });
        }).on("error", (err) => {
            reject(err);
        });
    });
};

const fetchTwelveDataQuotes = async (symbols) => {
    if (!TWELVEDATA_API_KEY) {
        return [];
    }

    const twelveSymbols = symbols.map(toTwelveDataSymbol);
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(twelveSymbols.join(","))}&apikey=${encodeURIComponent(TWELVEDATA_API_KEY)}`;

    const payload = await fetchJsonByUrl(url);

    if (payload?.code && payload?.message) {
        throw new Error(`TwelveData error: ${payload.message}`);
    }

    const output = [];

    if (payload && typeof payload === "object" && payload.symbol && !payload.code) {
        output.push({
            symbol: String(payload.symbol),
            close: Number(payload.close),
            change: Number(payload.change),
            percent_change: Number(payload.percent_change),
            currency: payload.currency,
            is_market_open: payload.is_market_open
        });
    } else if (payload && typeof payload === "object") {
        Object.entries(payload).forEach(([symbolKey, value]) => {
            if (value && typeof value === "object" && !value.code) {
                output.push({
                    symbol: value.symbol ? String(value.symbol) : symbolKey,
                    close: Number(value.close),
                    change: Number(value.change),
                    percent_change: Number(value.percent_change),
                    currency: value.currency,
                    is_market_open: value.is_market_open
                });
            }
        });
    }

    return output;
};

const parseAuthToken = (authHeader = "") => {
    const token = String(authHeader).startsWith("Bearer ") ? String(authHeader).slice(7) : "";
    if (!token) {
        return null;
    }

    try {
        return jwt.verify(token, process.env.JWT_SECRET || "secretkey");
    } catch (err) {
        return null;
    }
};

const containsAny = (text = "", words = []) => words.some((word) => text.includes(word));

const getKnownSymbolFromMessage = (message = "") => {
    const upperMsg = String(message).toUpperCase();
    return Object.keys(PAPER_PRICES).find((symbol) => upperMsg.includes(symbol));
};

const fetchOpenAIResponse = (message) => {
    if (!OPENAI_API_KEY) {
        return Promise.resolve("");
    }

    const body = JSON.stringify({
        model: OPENAI_MODEL,
        input: [
            {
                role: "system",
                content: "You are NiveshBot, a concise support assistant for a fintech trading app. Answer clearly in plain text. Do not mention internal APIs. If asked about personal portfolio data, ask user to log in or check dashboard."
            },
            {
                role: "user",
                content: String(message || "")
            }
        ],
        max_output_tokens: 220,
        temperature: 0.4
    });

    const options = {
        hostname: "api.openai.com",
        path: "/v1/responses",
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${OPENAI_API_KEY}`
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, (resp) => {
            let raw = "";

            resp.on("data", (chunk) => {
                raw += chunk;
            });

            resp.on("end", () => {
                try {
                    const payload = JSON.parse(raw || "{}");
                    if (resp.statusCode >= 400) {
                        return reject(new Error(payload?.error?.message || "OpenAI request failed"));
                    }

                    const outputText = String(payload?.output_text || "").trim();
                    if (outputText) {
                        return resolve(outputText);
                    }

                    const fallbackText = payload?.output?.[0]?.content?.[0]?.text;
                    resolve(String(fallbackText || "").trim());
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on("error", (error) => reject(error));
        req.write(body);
        req.end();
    });
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

const isValidEmail = (value = "") => EMAIL_REGEX.test(String(value).trim());

const generateVerificationCode = () => String(Math.floor(100000 + Math.random() * 900000));

const smtpTransport = SMTP_HOST && SMTP_FROM
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
    })
    : null;

const sendVerificationEmail = async ({ toEmail, fullName, verificationCode }) => {
    if (!smtpTransport) {
        throw new Error("SMTP not configured");
    }

    const html = `
        <div style="font-family: Inter, Arial, sans-serif; line-height: 1.5; color: #111;">
            <h2 style="margin-bottom: 12px;">Verify your email</h2>
            <p>Hi ${fullName || "there"},</p>
            <p>Your verification code is:</p>
            <div style="font-size: 28px; letter-spacing: 4px; font-weight: 700; margin: 10px 0 16px;">${verificationCode}</div>
            <p>This code expires in 15 minutes.</p>
        </div>
    `;

    await smtpTransport.sendMail({
        from: SMTP_FROM,
        to: toEmail,
        subject: "Verify your account email",
        html
    });
};

const fetchJsonByRequest = (options, body = "") => {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (resp) => {
            let raw = "";

            resp.on("data", (chunk) => {
                raw += chunk;
            });

            resp.on("end", () => {
                try {
                    const parsed = raw ? JSON.parse(raw) : {};
                    if (resp.statusCode >= 400) {
                        return reject(new Error(parsed?.error_description || parsed?.error?.message || parsed?.error || "Request failed"));
                    }
                    resolve(parsed);
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on("error", (error) => reject(error));
        if (body) {
            req.write(body);
        }
        req.end();
    });
};

const buildChatbotResponse = async ({ message, userId }) => {
    const cleanMessage = String(message || "").trim();
    const lowerMessage = cleanMessage.toLowerCase();

    let holdingsCount = 0;
    let positionsCount = 0;
    let ordersCount = 0;
    let latestOrder = null;

    if (userId) {
        const [holdings, positions, orders] = await Promise.all([
            HoldingsModel.find({ userId }).select("name qty price").lean(),
            PositionsModel.find({ userId }).select("name qty price").lean(),
            OrdersModel.find({ userId }).sort({ _id: -1 }).limit(1).lean()
        ]);

        holdingsCount = holdings.length;
        positionsCount = positions.length;
        latestOrder = orders[0] || null;

        const aggregateOrders = await OrdersModel.countDocuments({ userId });
        ordersCount = aggregateOrders;
    }

    const matchedSymbol = getKnownSymbolFromMessage(cleanMessage);
    if (matchedSymbol) {
        const price = getPaperPrice(matchedSymbol);
        return {
            answer: `The latest available reference price for ${matchedSymbol} is INR ${Number(price).toFixed(2)} in this environment. Use Buy/Sell from the watchlist to place an order.`,
            suggestions: ["How do I place a buy order?", "Explain order types", "Show my latest order"],
            handoffRecommended: false
        };
    }

    if (containsAny(lowerMessage, ["hi", "hello", "hey"])) {
        return {
            answer: "Hello. I can help with orders, holdings, positions, market quotes, and risk basics. Ask me something like 'How do I place a sell order?'",
            suggestions: ["How do I place a buy order?", "What are market hours?", "How can I reduce risk?"],
            handoffRecommended: false
        };
    }

    if (containsAny(lowerMessage, ["buy", "sell", "place order", "order place", "new order"])) {
        return {
            answer: "To place an order: open the watchlist, choose the stock, select BUY or SELL, enter quantity, then submit. BUY creates a holding entry; SELL reduces your holding quantity and needs enough available quantity.",
            suggestions: ["What if I sell more than I own?", "What are order types?", "Show my order status"],
            handoffRecommended: false
        };
    }

    if (containsAny(lowerMessage, ["order status", "latest order", "order history", "my orders"])) {
        if (!userId) {
            return {
                answer: "Log in to view your personal order history. After login, I can summarize your latest order and overall order count.",
                suggestions: ["How do I log in?", "How do I place an order?", "What are market hours?"],
                handoffRecommended: false
            };
        }

        if (!latestOrder) {
            return {
                answer: "You have no orders yet. Place your first BUY/SELL order from the watchlist and I can summarize it here.",
                suggestions: ["How do I place a buy order?", "Explain holdings vs positions", "How do I track P&L?"],
                handoffRecommended: false
            };
        }

        return {
            answer: `You have ${ordersCount} total orders. Latest order: ${latestOrder.mode} ${latestOrder.qty} shares of ${latestOrder.name} at INR ${Number(latestOrder.price || 0).toFixed(2)}.`,
            suggestions: ["Explain holdings vs positions", "How can I reduce risk?", "Show market quote for TCS"],
            handoffRecommended: false
        };
    }

    if (containsAny(lowerMessage, ["holding", "portfolio", "position", "positions"])) {
        if (!userId) {
            return {
                answer: "Log in to access your personalized portfolio data. I can then summarize holdings, positions, and recent activity.",
                suggestions: ["How do I log in?", "What is a holding?", "What is a position?"],
                handoffRecommended: false
            };
        }

        return {
            answer: `Portfolio snapshot: ${holdingsCount} holdings and ${positionsCount} positions are currently available in your account.`,
            suggestions: ["Show my latest order", "How can I manage risk?", "How do I place a sell order?"],
            handoffRecommended: false
        };
    }

    if (containsAny(lowerMessage, ["market hours", "trading hours", "when market open", "market open"])) {
        return {
            answer: "For NSE equity sessions, regular trading is usually 09:15 to 15:30 IST on business days. Confirm exchange holidays and session changes before placing orders.",
            suggestions: ["How do I place an order?", "Show market quote for INFY", "What is risk management?"],
            handoffRecommended: false
        };
    }

    if (containsAny(lowerMessage, ["risk", "stop loss", "loss", "drawdown", "protect"])) {
        return {
            answer: "Basic risk controls: define maximum loss per trade, avoid over-sizing positions, diversify, and use stop-loss levels before entry. Keep a trade journal and review losing setups.",
            suggestions: ["How to size my position?", "How do I place a sell order?", "How do I track portfolio?"],
            handoffRecommended: false
        };
    }

    if (containsAny(lowerMessage, ["fund", "deposit", "withdraw", "payment", "transfer"])) {
        return {
            answer: "For fund transfers, use the support section and select 'Fund Transfer' while creating a ticket. Include transaction reference and timestamp for faster help.",
            suggestions: ["Open support ticket", "How do I check order status?", "How do I contact support?"],
            handoffRecommended: true
        };
    }

    if (OPENAI_API_KEY) {
        try {
            const openAiAnswer = await fetchOpenAIResponse(cleanMessage);
            if (openAiAnswer) {
                return {
                    answer: openAiAnswer,
                    suggestions: ["How do I place a buy order?", "Explain holdings vs positions", "How do I create a support ticket?"],
                    handoffRecommended: false
                };
            }
        } catch (error) {
            console.log("OpenAI fallback failed", error?.message || error);
        }
    }

    return {
        answer: "I can help with orders, holdings, positions, market hours, risk basics, and fund-query guidance. If your issue is account-specific or unresolved, please create a support ticket from the support page.",
        suggestions: ["How do I place a buy order?", "Explain holdings vs positions", "How do I create a support ticket?"],
        handoffRecommended: true
    };
};


// authentication middleware
const authenticate = (req, res, next) => {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) {
        return res.status(401).json({ message: "No token provided" });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "secretkey");
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ message: "Invalid token" });
    }
};

//from this the data will be coming directly from the database not from the data.js file
app.get("/allHoldings", async (req, res) => {
    // public listing of all holdings (admin-style)
    let allHoldings = await HoldingsModel.find({});
    res.json(allHoldings);
});

app.get("/myHoldings", authenticate, async (req, res) => {
    try {
        const holdings = await HoldingsModel.find({ userId: req.user.id });
        res.json(holdings);
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Error fetching user holdings" });
    }
});

app.get("/allPositions", async (req, res) => {
    let allPositions = await PositionsModel.find({});
    res.json(allPositions);
});

app.get("/myPositions", authenticate, async (req, res) => {
    try {
        const positions = await PositionsModel.find({ userId: req.user.id });
        res.json(positions);
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Error fetching user positions" });
    }
});

// user authentication endpoints
app.post("/signup", async (req, res) => {
    try {
        const { fullName, email, username, password } = req.body;
        if (!fullName || !email || !username || !password) {
            return res.status(400).json({ message: "All fields are required" });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const normalizedUsername = String(username).trim();

        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json({ message: "Please enter a valid email address" });
        }

        if (!smtpTransport) {
            return res.status(500).json({ message: "Email verification service is not configured" });
        }

        const existing = await UserModel.findOne({ $or: [{ email: normalizedEmail }, { username: normalizedUsername }] });
        if (existing) {
            return res.status(400).json({ message: "Email or username already in use" });
        }

        const hash = await bcrypt.hash(password, 10);
        const verificationCode = generateVerificationCode();
        const newUser = new UserModel({
            fullName: String(fullName).trim(),
            email: normalizedEmail,
            username: normalizedUsername,
            passwordHash: hash,
            profileImage: "",
            isEmailVerified: false,
            emailVerificationCode: verificationCode,
            emailVerificationExpiresAt: new Date(Date.now() + 15 * 60 * 1000)
        });

        await newUser.save();
        await sendVerificationEmail({
            toEmail: normalizedEmail,
            fullName: String(fullName).trim(),
            verificationCode
        });

        res.status(201).json({ message: "Account created. Verification code sent to your email.", email: normalizedEmail });
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Error creating user" });
    }
});

app.post("/verify-email", async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const code = String(req.body?.code || "").trim();

        if (!email || !code) {
            return res.status(400).json({ message: "Email and verification code are required" });
        }

        const user = await UserModel.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "Account not found" });
        }

        if (user.isEmailVerified) {
            return res.status(200).json({ message: "Email already verified" });
        }

        if (!user.emailVerificationCode || user.emailVerificationCode !== code) {
            return res.status(400).json({ message: "Invalid verification code" });
        }

        if (!user.emailVerificationExpiresAt || new Date(user.emailVerificationExpiresAt).getTime() < Date.now()) {
            return res.status(400).json({ message: "Verification code expired. Please request a new one." });
        }

        user.isEmailVerified = true;
        user.emailVerificationCode = "";
        user.emailVerificationExpiresAt = null;
        await user.save();

        res.json({ message: "Email verified successfully. You can now log in." });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Error verifying email" });
    }
});

app.post("/resend-verification", async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({ message: "Please enter a valid email address" });
        }

        if (!smtpTransport) {
            return res.status(500).json({ message: "Email verification service is not configured" });
        }

        const user = await UserModel.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: "Account not found" });
        }

        if (user.isEmailVerified) {
            return res.status(200).json({ message: "Email already verified" });
        }

        const verificationCode = generateVerificationCode();
        user.emailVerificationCode = verificationCode;
        user.emailVerificationExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await user.save();

        await sendVerificationEmail({
            toEmail: email,
            fullName: user.fullName,
            verificationCode
        });

        res.json({ message: "Verification code sent" });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Error sending verification code" });
    }
});

app.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: "Email and password required" });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        if (!isValidEmail(normalizedEmail)) {
            return res.status(400).json({ message: "Please enter a valid email address" });
        }

        const user = await UserModel.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const isVerified = user.isEmailVerified === undefined ? true : Boolean(user.isEmailVerified);
        if (!isVerified) {
            return res.status(403).json({ message: "Please verify your email before logging in" });
        }

        if (!user.passwordHash) {
            return res.status(400).json({ message: "Use OAuth login for this account" });
        }

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) {
            return res.status(400).json({ message: "Invalid credentials" });
        }
        const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET || "secretkey", { expiresIn: "2h" });
        res.json({
            message: "Login successful",
            token,
            user: {
                id: user._id,
                fullName: user.fullName,
                email: user.email,
                username: user.username,
                profileImage: user.profileImage || ""
            }
        });
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Error logging in" });
    }
});

app.get("/auth/google/start", (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return res.status(500).send("Google OAuth is not configured");
    }

    const returnTo = String(req.query?.returnTo || "").trim();
    const state = crypto.randomBytes(16).toString("hex");
    const statePayload = Buffer.from(JSON.stringify({ state, returnTo }), "utf8").toString("base64url");
    const query = querystring.stringify({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: "code",
        scope: "openid email profile",
        access_type: "offline",
        prompt: "consent",
        state: statePayload
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${query}`);
});

app.get("/auth/google/callback", async (req, res) => {
    try {
        if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
            return res.status(500).send("Google OAuth is not configured");
        }

        const code = String(req.query?.code || "").trim();
        if (!code) {
            return res.status(400).send("Missing authorization code");
        }

        const statePayload = String(req.query?.state || "").trim();
        let returnTo = `${FRONTEND_URL}/signup`;
        if (statePayload) {
            try {
                const decodedState = JSON.parse(Buffer.from(statePayload, "base64url").toString("utf8"));
                if (decodedState?.returnTo && String(decodedState.returnTo).startsWith("http")) {
                    returnTo = String(decodedState.returnTo);
                }
            } catch (stateError) {
                console.log("OAuth state decode failed", stateError?.message || stateError);
            }
        }

        const tokenBody = querystring.stringify({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: GOOGLE_REDIRECT_URI,
            grant_type: "authorization_code"
        });

        const tokenPayload = await fetchJsonByRequest({
            hostname: "oauth2.googleapis.com",
            path: "/token",
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(tokenBody)
            }
        }, tokenBody);

        const accessToken = tokenPayload?.access_token;
        if (!accessToken) {
            return res.status(400).send("Unable to get OAuth access token");
        }

        const googleUser = await fetchJsonByRequest({
            hostname: "www.googleapis.com",
            path: "/oauth2/v3/userinfo",
            method: "GET",
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });

        const googleEmail = String(googleUser?.email || "").trim().toLowerCase();
        const googleSub = String(googleUser?.sub || "").trim();
        const googleName = String(googleUser?.name || googleEmail.split("@")[0] || "User").trim();
        const picture = String(googleUser?.picture || "").trim();

        if (!googleEmail || !googleSub || !isValidEmail(googleEmail)) {
            return res.status(400).send("Unable to validate Google account");
        }

        let user = await UserModel.findOne({ email: googleEmail });
        if (!user) {
            const usernameSeed = googleEmail.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "") || "user";
            const uniqueSuffix = Math.floor(1000 + Math.random() * 9000);
            user = await UserModel.create({
                fullName: googleName,
                email: googleEmail,
                username: `${usernameSeed}_${uniqueSuffix}`,
                passwordHash: "",
                profileImage: picture,
                isEmailVerified: true,
                oauthProvider: "google",
                oauthId: googleSub
            });
        } else {
            user.isEmailVerified = true;
            user.oauthProvider = "google";
            user.oauthId = googleSub;
            if (!user.profileImage && picture) {
                user.profileImage = picture;
            }
            await user.save();
        }

        const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET || "secretkey", { expiresIn: "2h" });
        const separator = returnTo.includes("?") ? "&" : "?";
        const redirectUrl = `${returnTo}${separator}oauthToken=${encodeURIComponent(token)}`;
        res.redirect(redirectUrl);
    } catch (error) {
        console.log("Google OAuth callback error", error);
        res.status(500).send("Google OAuth failed");
    }
});

// dashboard data endpoint
app.get("/dashboardData", authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const holdings = await HoldingsModel.find({ userId });
        const positions = await PositionsModel.find({ userId });
        const orders = await OrdersModel.find({ userId });
        res.json({ holdings, positions, orders });
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Error fetching dashboard data" });
    }
});

app.get("/market/quotes", authenticate, async (req, res) => {
    try {
        const symbolsFromQuery = String(req.query.symbols || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);

        const symbols = symbolsFromQuery.length
            ? [...new Set(symbolsFromQuery.map(normalizeSymbol))]
            : Object.keys(PAPER_PRICES);

        let source = "YAHOO_FINANCE";
        let quotes = [];

        if (MARKET_DATA_PROVIDER === "twelvedata" && TWELVEDATA_API_KEY) {
            try {
                const twelveData = await fetchTwelveDataQuotes(symbols);
                const byTwelveSymbol = new Map();
                twelveData.forEach((entry) => {
                    if (entry?.symbol) {
                        byTwelveSymbol.set(String(entry.symbol).toUpperCase(), entry);
                    }
                });

                quotes = symbols.map((symbol) => {
                    const twelveSymbol = toTwelveDataSymbol(symbol);
                    const twelveQuote = byTwelveSymbol.get(twelveSymbol.toUpperCase());
                    const lastPrice = Number(twelveQuote?.close);
                    const change = Number(twelveQuote?.change);
                    const changePercent = Number(twelveQuote?.percent_change);
                    const paperPrice = getPaperPrice(symbol);

                    return {
                        symbol,
                        marketSymbol: twelveSymbol,
                        lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
                        change: Number.isFinite(change) ? change : null,
                        changePercent: Number.isFinite(changePercent) ? changePercent : null,
                        currency: twelveQuote?.currency || "INR",
                        marketState: twelveQuote?.is_market_open ? "REGULAR" : "CLOSED",
                        paperPrice: Number.isFinite(paperPrice) ? paperPrice : null,
                        source: "TWELVE_DATA"
                    };
                });

                source = "TWELVE_DATA";
            } catch (providerError) {
                console.log("TwelveData fetch failed, fallback to Yahoo", providerError.message);
            }
        }

        if (!quotes.length) {
            const yahooData = await fetchYahooQuotes(symbols);

            const byYahooSymbol = new Map();
            yahooData.forEach((entry) => {
                if (entry?.symbol) {
                    byYahooSymbol.set(String(entry.symbol).toUpperCase(), entry);
                }
            });

            quotes = symbols.map((symbol) => {
                const yahooSymbol = toYahooSymbol(symbol);
                const yahooQuote = byYahooSymbol.get(yahooSymbol.toUpperCase());
                const lastPrice = Number(yahooQuote?.regularMarketPrice);
                const change = Number(yahooQuote?.regularMarketChange);
                const changePercent = Number(yahooQuote?.regularMarketChangePercent);
                const paperPrice = getPaperPrice(symbol);

                return {
                    symbol,
                    marketSymbol: yahooSymbol,
                    lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
                    change: Number.isFinite(change) ? change : null,
                    changePercent: Number.isFinite(changePercent) ? changePercent : null,
                    currency: yahooQuote?.currency || "INR",
                    marketState: yahooQuote?.marketState || "UNKNOWN",
                    paperPrice: Number.isFinite(paperPrice) ? paperPrice : null,
                    source: "YAHOO_FINANCE"
                };
            });

            source = "YAHOO_FINANCE";
        }

        res.json({
            source,
            timestamp: new Date().toISOString(),
            quotes
        });
    } catch (error) {
        console.log("Market fetch error, serving paper fallback", error?.message || error);

        const symbolsFromQuery = String(req.query.symbols || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);

        const symbols = symbolsFromQuery.length
            ? [...new Set(symbolsFromQuery.map(normalizeSymbol))]
            : Object.keys(PAPER_PRICES);

        const fallbackQuotes = symbols.map((symbol) => {
            const paperPrice = getPaperPrice(symbol);
            const simulatedTick = generateSimulatedTick(symbol, paperPrice);
            return {
                symbol,
                marketSymbol: symbol,
                lastPrice: Number.isFinite(simulatedTick.lastPrice) ? simulatedTick.lastPrice : 0,
                change: Number.isFinite(simulatedTick.change) ? simulatedTick.change : 0,
                changePercent: Number.isFinite(simulatedTick.changePercent) ? simulatedTick.changePercent : 0,
                currency: "INR",
                marketState: "SIMULATED",
                paperPrice: Number.isFinite(paperPrice) ? paperPrice : null,
                source: "PAPER_FALLBACK"
            };
        });

        res.json({
            source: "PAPER_FALLBACK",
            timestamp: new Date().toISOString(),
            quotes: fallbackQuotes
        });
    }
});

app.post("/newOrder", authenticate, async (req, res) => {
    try {
        const { name, qty, price, mode } = req.body;
        const userId = req.user.id;
        const normalizedName = normalizeSymbol(name);
        const requestedQty = Number(qty);
        const fallbackPrice = Number(price);
        const executionPrice = getPaperPrice(normalizedName);
        const finalPrice = Number.isFinite(executionPrice)
            ? executionPrice
            : (Number.isFinite(fallbackPrice) ? fallbackPrice : 0);

        if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
            return res.status(400).json({ message: "Quantity must be greater than 0" });
        }

        if (!mode || !["BUY", "SELL"].includes(String(mode).toUpperCase())) {
            return res.status(400).json({ message: "Order mode must be BUY or SELL" });
        }

        // 🔹 SELL LOGIC
        if (String(mode).toUpperCase() === "SELL") {
            const holding = await HoldingsModel.findOne({ name: normalizedName, userId });

            if (!holding) {
                return res.status(400).json({
                    message: "You do not own this stock",
                });
            }

            if (requestedQty > holding.qty) {
                return res.status(400).json({
                    message: "Not enough quantity to sell",
                });
            }

            holding.qty -= requestedQty;

            if (holding.qty === 0) {
                await HoldingsModel.deleteOne({ _id: holding._id });
            } else {
                holding.price = finalPrice;
                await holding.save();
            }
        }

        // 🔹 BUY LOGIC (ALWAYS CREATE NEW ENTRY)
        if (String(mode).toUpperCase() === "BUY") {
            await HoldingsModel.create({
                userId,
                name: normalizedName,
                qty: requestedQty,
                avg: finalPrice,
                price: finalPrice,
                net: "0%",
                day: "0%",
            });
        }

        // 🔹 ALWAYS SAVE ORDER (for both BUY & SELL)
        const newOrder = new OrdersModel({
            userId,
            name: normalizedName,
            qty: requestedQty,
            price: finalPrice,
            mode: String(mode).toUpperCase(),
        });

        await newOrder.save();

        res.status(200).json({ message: "Order placed successfully" });

    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Server error" });
    }
});

app.get("/allOrders", async (req, res) => {
    try {
        const orders = await OrdersModel.find({});
        res.json(orders);
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Error fetching orders" });
    }
});

app.get("/me", authenticate, async (req, res) => {
    try {
        const user = await UserModel.findById(req.user.id).select("fullName email username profileImage createdAt");
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }
        res.json(user);
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Error fetching user profile" });
    }
});

app.put("/me", authenticate, async (req, res) => {
    try {
        const { fullName, email, username } = req.body;

        const updates = {};
        if (typeof fullName === "string" && fullName.trim()) {
            updates.fullName = fullName.trim();
        }

        if (typeof email === "string" && email.trim()) {
            const normalizedEmail = email.trim().toLowerCase();
            const existingEmail = await UserModel.findOne({ email: normalizedEmail, _id: { $ne: req.user.id } });
            if (existingEmail) {
                return res.status(400).json({ message: "Email already in use" });
            }
            updates.email = normalizedEmail;
        }

        if (typeof username === "string" && username.trim()) {
            const normalizedUsername = username.trim();
            const existingUsername = await UserModel.findOne({ username: normalizedUsername, _id: { $ne: req.user.id } });
            if (existingUsername) {
                return res.status(400).json({ message: "Username already in use" });
            }
            updates.username = normalizedUsername;
        }

        const updatedUser = await UserModel.findByIdAndUpdate(
            req.user.id,
            updates,
            { new: true }
        ).select("fullName email username profileImage createdAt");

        res.json({ message: "Profile updated successfully", user: updatedUser });
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Error updating profile" });
    }
});

app.put("/me/avatar", authenticate, async (req, res) => {
    try {
        const { profileImage } = req.body;
        if (typeof profileImage !== "string" || !profileImage.startsWith("data:image/")) {
            return res.status(400).json({ message: "Invalid image format" });
        }

        if (profileImage.length > 2_000_000) {
            return res.status(400).json({ message: "Image is too large" });
        }

        const updatedUser = await UserModel.findByIdAndUpdate(
            req.user.id,
            { profileImage },
            { new: true }
        ).select("fullName email username profileImage createdAt");

        res.json({ message: "Avatar updated successfully", user: updatedUser });
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Error uploading avatar" });
    }
});

app.get("/myOrders", authenticate, async (req, res) => {
    try {
        const orders = await OrdersModel.find({ userId: req.user.id }).sort({ _id: -1 });
        res.json(orders);
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Error fetching user orders" });
    }
});

// Support Query Endpoints
app.post("/submitSupportQuery", async (req, res) => {
    try {
        const { userName, email, phone, category, subject, message } = req.body;

        // Validate required fields
        if (!userName || !email || !category || !subject || !message) {
            return res.status(400).json({
                message: "Please fill in all required fields"
            });
        }

        // Create new support query
        const newQuery = new SupportQueryModel({
            userName,
            email,
            phone,
            category,
            subject,
            message,
            status: "Open"
        });

        await newQuery.save();

        res.status(200).json({
            message: "Support query submitted successfully",
            queryId: newQuery._id
        });

    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Error submitting support query" });
    }
});

app.get("/allSupportQueries", async (req, res) => {
    try {
        const queries = await SupportQueryModel.find({}).sort({ createdAt: -1 });
        res.json(queries);
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Error fetching support queries" });
    }
});

app.get("/supportQuery/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const query = await SupportQueryModel.findById(id);

        if (!query) {
            return res.status(404).json({ message: "Query not found" });
        }

        res.json(query);
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Error fetching query" });
    }
});

app.put("/updateQueryStatus/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        const updatedQuery = await SupportQueryModel.findByIdAndUpdate(
            id,
            { status, updatedAt: Date.now() },
            { new: true }
        );

        if (!updatedQuery) {
            return res.status(404).json({ message: "Query not found" });
        }

        res.json({
            message: "Query status updated successfully",
            query: updatedQuery
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Error updating query status" });
    }
});

app.post("/chatbot/query", async (req, res) => {
    try {
        const message = String(req.body?.message || "").trim();

        if (!message) {
            return res.status(400).json({ message: "Message is required" });
        }

        const authPayload = parseAuthToken(req.headers["authorization"] || "");
        const userId = authPayload?.id || null;

        const payload = await buildChatbotResponse({ message, userId });
        res.json({
            answer: payload.answer,
            suggestions: payload.suggestions || [],
            handoffRecommended: Boolean(payload.handoffRecommended)
        });
    } catch (error) {
        console.log("Chatbot error", error);
        res.status(500).json({
            message: "Unable to process chatbot query",
            answer: "I am facing a temporary issue. Please try again or create a support ticket.",
            suggestions: ["Create support ticket", "How do I place an order?"],
            handoffRecommended: true
        });
    }
});

app.listen(PORT, () => {
    console.log("App started...");
    mongoose.connect(uri);
    console.log("DataBase connected");
});



















//initial data to be inserted in the project
// database ka access hai directly yahi se kar lo

// temporary holdings data
// app.get("/addHoldings", async (req, res) => {
//     let tempHoldings = [
//         {
//             name: "BHARTIARTL",
//             qty: 2,
//             avg: 538.05,
//             price: 541.15,
//             net: "+0.58%",
//             day: "+2.99%",
//         },
//         {
//             name: "HDFCBANK",
//             qty: 2,
//             avg: 1383.4,
//             price: 1522.35,
//             net: "+10.04%",
//             day: "+0.11%",
//         },
//         {
//             name: "HINDUNILVR",
//             qty: 1,
//             avg: 2335.85,
//             price: 2417.4,
//             net: "+3.49%",
//             day: "+0.21%",
//         },
//         {
//             name: "INFY",
//             qty: 1,
//             avg: 1350.5,
//             price: 1555.45,
//             net: "+15.18%",
//             day: "-1.60%",
//             isLoss: true,
//         },
//         {
//             name: "ITC",
//             qty: 5,
//             avg: 202.0,
//             price: 207.9,
//             net: "+2.92%",
//             day: "+0.80%",
//         },
//         {
//             name: "KPITTECH",
//             qty: 5,
//             avg: 250.3,
//             price: 266.45,
//             net: "+6.45%",
//             day: "+3.54%",
//         },
//         {
//             name: "M&M",
//             qty: 2,
//             avg: 809.9,
//             price: 779.8,
//             net: "-3.72%",
//             day: "-0.01%",
//             isLoss: true,
//         },
//         {
//             name: "RELIANCE",
//             qty: 1,
//             avg: 2193.7,
//             price: 2112.4,
//             net: "-3.71%",
//             day: "+1.44%",
//         },
//         {
//             name: "SBIN",
//             qty: 4,
//             avg: 324.35,
//             price: 430.2,
//             net: "+32.63%",
//             day: "-0.34%",
//             isLoss: true,
//         },
//         {
//             name: "SGBMAY29",
//             qty: 2,
//             avg: 4727.0,
//             price: 4719.0,
//             net: "-0.17%",
//             day: "+0.15%",
//         },
//         {
//             name: "TATAPOWER",
//             qty: 5,
//             avg: 104.2,
//             price: 124.15,
//             net: "+19.15%",
//             day: "-0.24%",
//             isLoss: true,
//         },
//         {
//             name: "TCS",
//             qty: 1,
//             avg: 3041.7,
//             price: 3194.8,
//             net: "+5.03%",
//             day: "-0.25%",
//             isLoss: true,
//         },
//         {
//             name: "WIPRO",
//             qty: 4,
//             avg: 489.3,
//             price: 577.75,
//             net: "+18.08%",
//             day: "+0.32%",
//         },
//     ];

//     // har ek item ke liye model create karna hai aur isko datbase mein save kar dena hai...
//     tempHoldings.forEach((item) => {
//         //for wvery item we have to create a new model
//         let newHolding = new HoldingsModel({
//             //yeh structure schema se aayega
//             //yeh sare values ko fill karenge jo item mein honge
//             name: item.name,
//             qty: item.qty,
//             avg: item.avg,
//             price: item.price,
//             net: item.net,
//             day: item.day,
//         });

//         //mongo db mein function hota hai save naam ka
//         newHolding.save(); // this will save the data for us
//     });
//     res.send("Done");
// });


// temporary positions data
// app.get("/addPositions", async (req, res) => {
//     let tempPositions = [
//         {
//             product: "CNC",
//             name: "EVEREADY",
//             qty: 2,
//             avg: 316.27,
//             price: 312.35,
//             net: "+0.58%",
//             day: "-1.24%",
//             isLoss: true,
//         },
//         {
//             product: "CNC",
//             name: "JUBLFOOD",
//             qty: 1,
//             avg: 3124.75,
//             price: 3082.65,
//             net: "+10.04%",
//             day: "-1.35%",
//             isLoss: true,
//         },
//     ];

//     tempPositions.forEach((item) => {
//         let newPositions = new PositionsModel({
//             product: item.product,
//             name: item.name,
//             qty: item.qty,
//             avg: item.avg,
//             price: item.price,
//             net: item.net,
//             day: item.day,
//             isLoss: item.isLoss,
//         });
//         newPositions.save();
//     });
//     res.send("PositionsSave");
// });