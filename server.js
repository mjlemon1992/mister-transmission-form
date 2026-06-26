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

function smPost(path, body) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(body);
    var options = {
      hostname: SM_BASE,
      port: 443,
      path: "/v3" + path,
      method: "POST",
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
        try {
          var json = JSON.parse(Buffer.concat(chunks).toString());
          if (res.statusCode >= 400) {
            reject(new Error("Shopmonkey error: " + JSON.stringify(json)));
          } else {
            resolve(json);
          }
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, function() {
      req.destroy(new Error("Shopmonkey request timed out"));
    });
    req.write(data);
    req.end();
  });
}

// Generic Shopmonkey request (any method) — used for post-order updates.
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

// Best-effort: write the signed declaration (and signature marker) onto the
// order's internal notes. Non-blocking — never fails a check-in.
// NOTE: the exact Shopmonkey field/endpoint for internal notes + signature-image
// attachment must be confirmed with one live check-in, then adjusted here.
function attachDeclaration(orderId, customerId, b, isFleet) {
  if (!orderId || !customerId) return Promise.resolve();
  var signedBy = isFleet ? (b.companyName || "") : ((b.firstName || "") + " " + (b.lastName || "")).trim();
  var hasSig = !!b.signature;
  var text =
    "CUSTOMER CHECK-IN DECLARATION — agreed & signed at check-in\n" +
    "Signed by: " + signedBy + "\n" +
    "Date: " + new Date().toISOString() + "\n\n" +
    (b.declaration || "") +
    "\n\nSignature captured: " + (hasSig ? "YES" : "NO");
  console.log("attachDeclaration: order " + orderId +
    (hasSig ? " (signature ~" + Math.round(b.signature.length / 1024) + "KB)" : " (no signature)"));
  // Post as a note on the order's message thread (confirmed-working endpoint).
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

// TEMPORARY diagnostic — discovers the correct Shopmonkey note/message endpoint
// against a real order. Token-gated; remove once the attach is wired.
function smTry(method, apiPath, body) {
  return smRequest(method, apiPath, body).then(
    function(r) { return { ok: true, method: method, path: apiPath, response: r }; },
    function(e) { return { ok: false, method: method, path: apiPath, error: e.message }; }
  );
}
app.get("/__probe", function(req, res) {
  if (req.query.token !== "diag-7k2p9x") return res.status(403).json({ error: "forbidden" });
  var orderId = req.query.orderId;
  if (!orderId) return res.status(400).json({ error: "orderId required" });
  var note = "DIAG internal note " + new Date().toISOString();
  Promise.all([
    smTry("GET", "/order/" + orderId),
    smTry("POST", "/order/" + orderId + "/message", { type: "Internal", message: note }),
    smTry("POST", "/message", { orderId: orderId, type: "Internal", body: note }),
    smTry("POST", "/order/" + orderId + "/internal-message", { message: note }),
    smTry("POST", "/internal-message", { orderId: orderId, message: note }),
    smTry("GET", "/message?orderId=" + orderId),
    smTry("GET", "/message_thread?where[orderId]=" + orderId)
  ]).then(function(results) {
    results.forEach(function(r) {
      if (r.path === "/order/" + orderId && r.ok && r.response && r.response.data) {
        r.orderDataKeys = Object.keys(r.response.data);
        delete r.response;
      }
    });
    res.json({ orderId: orderId, results: results });
  });
});
app.get("/__probe2", function(req, res) {
  if (req.query.token !== "diag-7k2p9x") return res.status(403).json({ error: "forbidden" });
  var orderId = req.query.orderId;
  Promise.all([
    smTry("GET", "/order/" + orderId),
    smTry("GET", "/message?limit=8&sort=-createdDate")
  ]).then(function(r) {
    var order = (r[0].ok && r[0].response && r[0].response.data) || {};
    var msgs = (r[1].ok && r[1].response && r[1].response.data) || [];
    var sample = msgs[0] || {};
    var types = {};
    msgs.forEach(function(m) { types[m.type] = (types[m.type] || 0) + 1; });
    // field NAMES only (no content), plus which fields look note/body/internal related
    res.json({
      conversationId: order.conversationId,
      customerId: order.customerId,
      messageFieldNames: Object.keys(sample),
      distinctTypes: types,
      hasInternalFlag: ("internal" in sample) || ("isInternal" in sample)
    });
  });
});
app.get("/__probe3", function(req, res) {
  if (req.query.token !== "diag-7k2p9x") return res.status(403).json({ error: "forbidden" });
  var customerId = req.query.customerId;
  var orderId = req.query.orderId;
  var note = "DIAG internal note " + new Date().toISOString();
  function body(t) {
    return { customerId: customerId, orderId: orderId, text: note, type: t,
             internal: true, sendEmail: false, sendSms: false, contentType: "Text" };
  }
  Promise.all([
    smTry("POST", "/message", body("__INVALID__")),
    smTry("POST", "/message", body("Note")),
    smTry("POST", "/message", body("Internal")),
    smTry("GET", "/file?limit=2&sort=-createdDate")
  ]).then(function(r) {
    if (r[3] && r[3].ok && r[3].response && r[3].response.data && r[3].response.data[0]) {
      r[3] = { fileFieldNames: Object.keys(r[3].response.data[0]) };
    }
    res.json({ results: r });
  });
});
app.get("/__probe4", function(req, res) {
  if (req.query.token !== "diag-7k2p9x") return res.status(403).json({ error: "forbidden" });
  var customerId = req.query.customerId, orderId = req.query.orderId;
  function mk(extra) {
    return Object.assign({ customerId: customerId, orderId: orderId,
      text: "DIAG " + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      sendEmail: false, sendSms: false }, extra);
  }
  Promise.all([
    smTry("POST", "/message", mk({ internal: true })),
    smTry("POST", "/message", mk({ internal: true, type: "Internal" })),
    smTry("POST", "/message", mk({ internal: true, type: "Note" })),
    smTry("POST", "/file", { orderId: orderId }),
    smTry("POST", "/order/" + orderId + "/file", {}),
    smTry("GET", "/message?limit=50&sort=-createdDate")
  ]).then(function(r) {
    function sm(x) { return (x.ok && x.response && x.response.data)
      ? { ok: true, internal: x.response.data.internal, type: x.response.data.type, id: x.response.data.id } : x; }
    r[0] = sm(r[0]); r[1] = sm(r[1]); r[2] = sm(r[2]);
    var withFile = null;
    if (r[5].ok && r[5].response && r[5].response.data) {
      var arr = r[5].response.data;
      for (var k = 0; k < arr.length; k++) {
        if (arr[k].files && arr[k].files.length) { withFile = { fileKeys: Object.keys(arr[k].files[0]) }; break; }
      }
      r[5] = { messagesScanned: arr.length, withFile: withFile };
    }
    res.json({ results: r });
  });
});
app.get("/__probe5", function(req, res) {
  if (req.query.token !== "diag-7k2p9x") return res.status(403).json({ error: "forbidden" });
  var orderId = req.query.orderId, msgId = req.query.msgId;
  Promise.all([
    smTry("POST", "/file/upload", {}),
    smTry("POST", "/file/upload-url", { fileName: "sig.png", fileType: "image/png" }),
    smTry("POST", "/file/signed-url", { fileName: "sig.png", fileType: "image/png" }),
    smTry("POST", "/upload", {}),
    smTry("POST", "/attachment", {}),
    smTry("POST", "/order/" + orderId + "/upload", {}),
    smTry("POST", "/file/create", { fileName: "sig.png", fileType: "image/png" }),
    smTry("PATCH", "/message/" + msgId, { internal: true }),
    smTry("PUT", "/message/" + msgId, { internal: true })
  ]).then(function(r) { res.json({ results: r }); });
});
app.get("/__probe6", function(req, res) {
  if (req.query.token !== "diag-7k2p9x") return res.status(403).json({ error: "forbidden" });
  var orderId = req.query.orderId, customerId = req.query.customerId;
  var tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  Promise.all([
    smTry("POST", "/file/sign", { fileName: "sig.png", fileType: "image/png" }),
    smTry("POST", "/file/request-upload", { fileName: "sig.png", fileType: "image/png" }),
    smTry("POST", "/order/" + orderId + "/attachment", { fileName: "sig.png", fileType: "image/png" }),
    smTry("POST", "/order/" + orderId + "/file-upload", { fileName: "sig.png", fileType: "image/png" }),
    smTry("GET", "/file/upload-url?fileName=sig.png&fileType=image/png"),
    smTry("POST", "/order/" + orderId + "/file", { fileName: "sig.png", fileType: "image/png", fileSize: 100, base64: tiny }),
    smTry("POST", "/order/" + orderId + "/file", { fileName: "sig.png", fileType: "image/png", fileSize: 100, data: tiny }),
    smTry("POST", "/message", { customerId: customerId, orderId: orderId, text: "DIAG inline " + Date.now(), sendEmail: false, sendSms: false, files: [{ fileName: "sig.png", fileType: "image/png", base64: tiny }] })
  ]).then(function(r) {
    if (r[7] && r[7].ok && r[7].response && r[7].response.data) {
      r[7] = { ok: true, files: r[7].response.data.files, id: r[7].response.data.id };
    }
    res.json({ results: r });
  });
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
    // Attach the signed declaration to the work order after responding, so a
    // failure here can never block the customer's check-in.
    attachDeclaration(orderId, customerId, b, isFleet).catch(function(e) {
      console.error("attachDeclaration failed:", e && e.message);
    });
  })
  .catch(function(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  });
});

app.get("/__verify", function(req, res) {
  if (req.query.token !== "diag-7k2p9x") return res.status(403).json({ error: "forbidden" });
  var orderId = req.query.orderId;
  Promise.all([
    smTry("GET", "/order/" + orderId),
    smTry("GET", "/message?limit=100&sort=-createdDate")
  ]).then(function(r) {
    var order = (r[0].ok && r[0].response && r[0].response.data) || {};
    var msgs = ((r[1].ok && r[1].response && r[1].response.data) || [])
      .filter(function(m) { return m.orderId === orderId; })
      .map(function(m) { return { internal: m.internal, type: m.type, text: (m.text || "").slice(0, 120) }; });
    res.json({ messageCount: order.messageCount, messagesOnOrder: msgs });
  });
});

app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});
