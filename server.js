var express = require("express");
var cors = require("cors");
var https = require("https");
var path = require("path");

var app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "6mb" }));

var SM_API_KEY = (process.env.SM_API_KEY || "").trim();
var SM_BASE = "api.shopmonkey.cloud";
var PORT = process.env.PORT || 3000;

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

// Post the signed declaration as an internal note on the order's message thread.
// Non-blocking — never fails a check-in. (Shopmonkey's API can attach existing
// files by id but has no public upload endpoint, so the drawn signature image
// itself can't be pushed to the order via the API — see README.)
function attachDeclaration(orderId, customerId, b, isFleet) {
  if (!orderId || !customerId) return Promise.resolve();
  var signedBy = isFleet ? (b.companyName || "") : ((b.firstName || "") + " " + (b.lastName || "")).trim();
  var text =
    "CUSTOMER CHECK-IN DECLARATION — agreed & signed at check-in\n" +
    "Signed by: " + signedBy + "\n" +
    "Date: " + new Date().toISOString() + "\n\n" +
    (b.declaration || "") +
    "\n\nSignature captured on the check-in form: " + (b.signature ? "YES" : "NO");
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

// Serve the intake form (index.html lives at the repo root)
app.get("/", function(req, res) {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", function(req, res) {
  res.json({ status: "ok" });
});

app.post("/checkin", function(req, res) {
  var b = req.body || {};
  var isFleet = b.customerType === "fleet";

  // Basic validation before hitting the POS
  if (isFleet) {
    if (!b.companyName) {
      return res.status(400).json({ error: "companyName is required for fleet customers" });
    }
  } else if (!b.firstName || !b.lastName) {
    return res.status(400).json({ error: "firstName and lastName are required" });
  }
  if (!b.year || isNaN(Number(b.year))) {
    return res.status(400).json({ error: "A valid vehicle year is required" });
  }
  if (!b.make || !b.model) {
    return res.status(400).json({ error: "Vehicle make and model are required" });
  }

  // Fleet customers must NOT include firstName/lastName (Shopmonkey rejects them)
  var customerPayload = isFleet ? {
    customerType: "Fleet",
    companyName: b.companyName,
    address1: b.address,
    city: b.city,
    postalCode: b.postcode,
    referralSource: b.source || "other",
    emails: [{ email: b.email, primary: true }],
    phoneNumbers: [{ number: b.phone, primary: true }]
  } : {
    customerType: "Customer",
    firstName: b.firstName,
    lastName: b.lastName,
    address1: b.address,
    city: b.city,
    postalCode: b.postcode,
    referralSource: b.source || "other",
    emails: [{ email: b.email, primary: true }],
    phoneNumbers: [{ number: b.phone, primary: true }]
  };

  var customerId;
  var vehicleId;
  var orderId;

  smPost("/customer", customerPayload)
  .then(function(cd) {
    customerId = cd.data && cd.data.id;
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
    res.json({
      success: true,
      customerId: customerId,
      vehicleId: vehicleId,
      orderId: orderId
    });
    // Attach the signed declaration after responding, so a failure here can
    // never block the customer's check-in.
    attachDeclaration(orderId, customerId, b, isFleet).catch(function(e) {
      console.error("attachDeclaration failed:", e && e.message);
    });
  })
  .catch(function(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
});

app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});
