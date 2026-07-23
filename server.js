var express = require("express");
var cors = require("cors");
var https = require("https");
var path = require("path");
var crypto = require("crypto");
var fs = require("fs");
var app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy

// --- Config -----------------------------------------------------------------
var SM_API_KEY = (process.env.SM_API_KEY || "").trim();
var SM_BASE = "api.shopmonkey.cloud";
var PORT = process.env.PORT || 3000;

// Simple shared token the form sends with each submission. It is visible in the
// public form source, so it is NOT a secret — it exists to stop naive bots and
// accidental traffic. The real abuse control is the rate limiter below.
// Override with the CHECKIN_TOKEN env var if it ever needs rotating.
var CHECKIN_TOKEN = (process.env.CHECKIN_TOKEN || "mt-checkin-7f3a").trim();

// Server-authoritative declaration text. The client displays a copy, but THIS
// is what gets recorded — the client cannot alter the recorded declaration.
var DECLARATION =
  "The vehicle has valid insurance and registration. " +
  "Any fines linked to no insurance, registration, or illegal modifications " +
  "will be passed on to the customer. " +
  "Any vehicle left more than 5 days after completion will be charged $20 per " +
  "day plus tax, unless otherwise authorized by us.";

if (!SM_API_KEY) {
  console.error("FATAL: SM_API_KEY is not set — every check-in will fail. " +
    "Set it in the Railway service variables.");
}

// --- CORS: only our two form origins ---------------------------------------
var ALLOWED_ORIGINS = [
  "https://mjlemon1992.github.io",
  "https://mister-transmission-backend-production.up.railway.app"
];
app.use(cors({
  origin: function(origin, cb) {
    // Same-origin / non-browser requests have no Origin header; allow them —
    // the token + rate limit are the controls for those.
    if (!origin || ALLOWED_ORIGINS.indexOf(origin) !== -1) return cb(null, true);
    return cb(null, false);
  }
}));

app.use(express.json({ limit: "1mb" }));

// --- Shopmonkey client ------------------------------------------------------
function smRequest(method, apiPath, body) {
  return new Promise(function(resolve, reject) {
    var data = body ? JSON.stringify(body) : "";
    var options = {
      hostname: SM_BASE,
      port: 443,
      path: "/v3" + apiPath,
      method: method,
      headers: {
        "Authorization": "Bearer " + SM_API_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    };
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        var txt = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          reject(new Error("Shopmonkey " + method + " " + apiPath + " -> " + res.statusCode + ": " + txt));
        } else {
          try { resolve(JSON.parse(txt)); } catch(e) { resolve({}); }
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, function() {
      req.destroy(new Error("Shopmonkey request timed out"));
    });
    if (data) req.write(data);
    req.end();
  });
}
function smPost(apiPath, body) { return smRequest("POST", apiPath, body); }

// --- Validation (exported for tests) ---------------------------------------
function digitsOf(v) { return String(v || "").replace(/\D/g, ""); }

function validateCheckin(b) {
  var isFleet = b.customerType === "fleet";
  if (isFleet) {
    if (!b.companyName) return "companyName is required for fleet customers";
  } else if (!b.firstName || !b.lastName) {
    return "firstName and lastName are required";
  }
  var yr = Number(b.year);
  if (!b.year || isNaN(yr) || yr < 1900 || yr > 2100) return "A valid vehicle year is required";
  if (!b.make || !b.model) return "Vehicle make and model are required";
  var d = digitsOf(b.phone);
  if (d.length < 10 || d.length > 11) return "A valid 10-digit phone number is required";
  return null;
}

function buildCustomerPayload(b) {
  var isFleet = b.customerType === "fleet";
  var base = {
    address1: b.address,
    city: b.city,
    postalCode: b.postcode,
    referralSource: b.source || "other",
    emails: [{ email: b.email, primary: true }],
    phoneNumbers: [{ number: b.phone, primary: true }]
  };
  if (isFleet) {
    // Fleet customers must NOT include firstName/lastName (Shopmonkey rejects them)
    base.customerType = "Fleet";
    base.companyName = b.companyName;
  } else {
    base.customerType = "Customer";
    base.firstName = b.firstName;
    base.lastName = b.lastName;
  }
  return base;
}

// --- Declaration + signature recording (non-blocking, never fails a check-in)
function attachDeclaration(orderId, customerId, b, isFleet) {
  if (!orderId || !customerId) return Promise.resolve();
  var signedBy = isFleet ? (b.companyName || "") : ((b.firstName || "") + " " + (b.lastName || "")).trim();
  var now = new Date();
  var text =
    "CUSTOMER CHECK-IN DECLARATION — agreed & signed at check-in\n" +
    "Signed by: " + signedBy + "\n" +
    "Date: " + now.toISOString() +
    " (" + now.toLocaleString("en-CA", { timeZone: "America/Edmonton" }) + " MT)\n\n" +
    DECLARATION +
    "\n\nSignature captured on the check-in form: " + (b.signature ? "YES (image stored in the next internal note)" : "NO");
  return smRequest("POST", "/message", {
    customerId: customerId,
    orderId: orderId,
    text: text,
    internal: true,
    sendEmail: false,
    sendSms: false,
    contentType: "PlainText"
  });
}

// Shopmonkey's API has no file-upload endpoint, so the signature image is
// persisted as a data URL inside a second internal note on the order.
// To view it: copy the data:image/png... line into a browser address bar.
function storeSignature(orderId, customerId, sig) {
  if (!orderId || !customerId) return Promise.resolve();
  if (!sig || sig.indexOf("data:image/png;base64,") !== 0) return Promise.resolve();
  if (sig.length > 400000) {
    console.error("storeSignature: image too large (" + sig.length + " chars), skipping");
    return Promise.resolve();
  }
  return smRequest("POST", "/message", {
    customerId: customerId,
    orderId: orderId,
    text: "SIGNATURE IMAGE (check-in declaration). To view: copy the entire line below into a browser address bar.\n\n" + sig,
    internal: true,
    sendEmail: false,
    sendSms: false,
    contentType: "PlainText"
  });
}

// --- Idempotency: same person+vehicle within 10 min returns the same order --
var recentCheckins = new Map();
var IDEM_TTL_MS = 10 * 60 * 1000;
function idemKey(b) {
  return crypto.createHash("sha256").update([
    b.customerType, b.firstName, b.lastName, b.companyName,
    digitsOf(b.phone), b.year, b.make, b.model
  ].join("|").toLowerCase()).digest("hex");
}
function sweepIdem() {
  var now = Date.now();
  recentCheckins.forEach(function(v, k) {
    if (now - v.at > IDEM_TTL_MS) recentCheckins.delete(k);
  });
}

// --- Rate limit: plenty for a busy shop day, hostile to floods ---------------
// Dependency-free sliding-window limiter (30 requests / hour / IP).
var RL_WINDOW_MS = 60 * 60 * 1000;
var RL_MAX = 30;
var rlHits = new Map();
function checkinLimiter(req, res, next) {
  var ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?")
    .split(",")[0].trim();
  var now = Date.now();
  var hits = (rlHits.get(ip) || []).filter(function(t) { return now - t < RL_WINDOW_MS; });
  if (hits.length >= RL_MAX) {
    return res.status(429).json({ error: "Too many submissions from this connection — please ask a team member for help." });
  }
  hits.push(now);
  rlHits.set(ip, hits);
  if (rlHits.size > 5000) { // safety valve: never grow unbounded
    var cutoff = now - RL_WINDOW_MS;
    rlHits.forEach(function(v, k) { if (!v.length || v[v.length - 1] < cutoff) rlHits.delete(k); });
  }
  next();
}

// --- Routes -----------------------------------------------------------------
var INDEX_PATH = fs.existsSync(path.join(__dirname, "index.html"))
  ? path.join(__dirname, "index.html")
  : path.join(__dirname, "public", "index.html");

if (fs.existsSync(path.join(__dirname, "public"))) {
  app.use(express.static(path.join(__dirname, "public")));
}

app.get("/", function(req, res) {
  res.sendFile(INDEX_PATH);
});

app.get("/health", function(req, res) {
  if (req.query.deep === "1") {
    // Deep check: verify the Shopmonkey key actually works.
    smRequest("GET", "/message?limit=1").then(function() {
      res.json({ status: "ok", shopmonkey: "ok" });
    }).catch(function(e) {
      res.status(502).json({ status: "degraded", shopmonkey: "failing", detail: String(e.message).slice(0, 200) });
    });
  } else {
    res.json({ status: "ok", smKeyPresent: !!SM_API_KEY });
  }
});

// Ops helper: check a specific order's note count (token-gated, read-only).
app.get("/status/:orderId", function(req, res) {
  if ((req.query.token || "") !== CHECKIN_TOKEN) return res.status(403).json({ error: "forbidden" });
  smRequest("GET", "/order/" + req.params.orderId).then(function(r) {
    res.json({ messageCount: r.data && r.data.messageCount, name: r.data && r.data.coalescedName });
  }).catch(function() {
    res.status(502).json({ error: "upstream" });
  });
});

app.post("/checkin", checkinLimiter, function(req, res) {
  if ((req.headers["x-checkin-token"] || "") !== CHECKIN_TOKEN) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  var b = req.body || {};
  var isFleet = b.customerType === "fleet";

  var invalid = validateCheckin(b);
  if (invalid) return res.status(400).json({ error: invalid });

  // Idempotency: a retry/double-tap inside 10 min returns the original order.
  sweepIdem();
  var key = idemKey(b);
  var cached = recentCheckins.get(key);
  if (cached) {
    console.log("checkin: duplicate within TTL, returning original order " + cached.result.orderId);
    return res.json(Object.assign({ duplicate: true }, cached.result));
  }

  var customerId, vehicleId, orderId;
  var step = "customer";

  smPost("/customer", buildCustomerPayload(b))
  .then(function(cd) {
    customerId = cd.data && cd.data.id;
    step = "vehicle";
    return smPost("/vehicle", {
      customerId: customerId,
      year: Number(b.year),
      make: b.make,
      model: b.model,
      size: b.vsize || "LightDuty",
      color: b.color || "Other"
    });
  })
  .then(function(vd) {
    vehicleId = vd.data && vd.data.id;
    step = "order";
    var orderName = b.year + " " + b.make + " " + b.model;
    orderName += " - " + (isFleet ? b.companyName : b.firstName + " " + b.lastName);
    return smPost("/order", {
      customerId: customerId,
      vehicleId: vehicleId,
      name: orderName,
      statusLabel: "Estimate"
    });
  })
  .then(function(od) {
    orderId = od.data && od.data.id;
    var result = { success: true, customerId: customerId, vehicleId: vehicleId, orderId: orderId };
    recentCheckins.set(key, { at: Date.now(), result: result });
    res.json(result);
    // Record declaration + signature after responding, so a failure here can
    // never block the customer's check-in.
    attachDeclaration(orderId, customerId, b, isFleet)
      .then(function() { return storeSignature(orderId, customerId, b.signature); })
      .catch(function(e) {
        console.error("declaration/signature recording failed for order " + orderId + ":", e && e.message);
      });
  })
  .catch(function(err) {
    console.error("CHECKIN FAILED at step '" + step + "':", err && err.message);
    if (customerId && !orderId) {
      console.error("ORPHAN WARNING: customer " + customerId +
        (vehicleId ? " + vehicle " + vehicleId : "") +
        " created in Shopmonkey without an order — clean up manually.");
    }
    res.status(500).json({ error: "Unable to complete check-in — please ask a team member for help." });
  });
});

// VoIP call-intelligence module (checkin repo only). Opt-in via env.
if (process.env.VOIP_ENABLED === "1" && fs.existsSync(path.join(__dirname, "voip"))) {
  require("./voip").start(app);
}

if (require.main === module) {
  app.listen(PORT, function() {
    console.log("Server running on port " + PORT);
  });
}

module.exports = { app: app, validateCheckin: validateCheckin, buildCustomerPayload: buildCustomerPayload, DECLARATION: DECLARATION };
