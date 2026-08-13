require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// Initialize Express
const app = express();

// ============================================
// CORS - MUST BE FIRST
// ============================================
const allowedOrigins = [
  "http://localhost:5500",
  "http://localhost:5501",
  "http://localhost:3000",
  "http://127.0.0.1:5500",
  "http://127.0.0.1:5501",
  "http://127.0.0.1:5502",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        return callback(null, true); // Allow all for now while debugging
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// ============================================
// SECURITY & PARSING MIDDLEWARE
// ============================================
app.use(helmet());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan("combined"));

// Make supabase available to routes
app.use((req, res, next) => {
  req.supabase = supabase;
  next();
});

// Rate Limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { error: "Too many requests, please try again later." },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    error: "Too many authentication attempts, please try again later.",
  },
});
app.use(generalLimiter);

// ============================================
// IMPORT CUSTOMER ROUTES
// ============================================
const authRoutes = require("./routes/auth");
const accountRoutes = require("./routes/accounts");
const transferRoutes = require("./routes/transfers");
const cardRoutes = require("./routes/cards");
const savingsRoutes = require("./routes/savings");
const investmentRoutes = require("./routes/investments");
const loanRoutes = require("./routes/loans");
const supportRoutes = require("./routes/support");
const notificationRoutes = require("./routes/notifications");

// ============================================
// IMPORT ADMIN ROUTES
// ============================================
const adminUserRoutes = require("./routes/admin/users");
const adminBalanceRoutes = require("./routes/admin/balances");
const adminLimitRoutes = require("./routes/admin/limits");
const adminAuditRoutes = require("./routes/admin/audit");
const adminImpersonationRoutes = require("./routes/admin/impersonation");
const adminSupportRoutes = require("./routes/admin/support");
const adminSettingsRoutes = require("./routes/admin/settings");
const adminSecurityRoutes = require("./routes/admin/security");
const adminSimulationRoutes = require("./routes/admin/simulation");
const adminReportRoutes = require("./routes/admin/reports");

// ============================================
// CUSTOMER API ROUTES
// ============================================
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/transfers", transferRoutes);
app.use("/api/cards", cardRoutes);
app.use("/api/savings", savingsRoutes);
app.use("/api/investments", investmentRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/notifications", notificationRoutes);

// ============================================
// ADMIN API ROUTES
// ============================================
app.use("/api/admin/users", adminUserRoutes);
app.use("/api/admin/balances", adminBalanceRoutes);
app.use("/api/admin/limits", adminLimitRoutes);
app.use("/api/admin/audit", adminAuditRoutes);
app.use("/api/admin/impersonation", adminImpersonationRoutes);
app.use("/api/admin/support", adminSupportRoutes);
app.use("/api/admin/settings", adminSettingsRoutes);
app.use("/api/admin/security", adminSecurityRoutes);
app.use("/api/admin/simulation", adminSimulationRoutes);
app.use("/api/admin/reports", adminReportRoutes);

// ============================================
// HEALTH CHECK
// ============================================
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mode: "DEMO/SIMULATION",
  });
});

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  console.error("Error:", err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.message || "Internal Server Error",
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ============================================
// EXPORT FOR VERCEL (DO NOT USE app.listen)
// ============================================
module.exports = app;
