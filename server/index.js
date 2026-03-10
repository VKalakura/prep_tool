const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const uploadRoutes = require("./routes/upload");
const processRoutes = require("./routes/process");
const widgetRoutes = require("./routes/widgets");
const phpRoutes = require("./routes/php");
const buildRoutes = require("./routes/build");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    credentials: true,
  }),
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/widgets", express.static(path.join(__dirname, "../widgets")));

const dirs = [path.join(__dirname, "sessions")];
dirs.forEach((d) => fs.mkdirSync(d, { recursive: true }));

app.use("/api/upload", uploadRoutes);
app.use("/api/process", processRoutes);
app.use("/api/widgets", widgetRoutes);
app.use("/api/php", phpRoutes);
app.use("/api/build", buildRoutes);

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.use((req, res) => {
  res.status(200).send(`
    <html><body style="font-family:sans-serif;padding:40px;background:#0f1117;color:#e2e8f0">
      <h2>Offer Prep Tool — API</h2>
      <p>UI: <a href="http://localhost:5173" style="color:#6366f1">http://localhost:5173</a></p>
    </body></html>
  `);
});

// Global error handler — prevents unhandled errors from crashing the server
app.use((err, req, res, _next) => {
  console.error("[server] Unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log("");
  console.log("  ┌─────────────────────────────────────────┐");
  console.log(`  │  API Server  →  http://localhost:${PORT}   │`);
  console.log("  │  Open UI    →  http://localhost:5173    │");
  console.log("  └─────────────────────────────────────────┘");
  console.log("");
});
