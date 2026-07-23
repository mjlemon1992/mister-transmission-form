var test = require("node:test");
var assert = require("node:assert");
var srv = require("./server.js");
var validateCheckin = srv.validateCheckin;
var buildCustomerPayload = srv.buildCustomerPayload;

function goodIndividual() {
  return {
    customerType: "individual", firstName: "Jane", lastName: "Doe",
    address: "1 Main St", city: "Red Deer", postcode: "T4N 0T0",
    phone: "403-555-0123", email: "jane@example.com",
    year: "2019", make: "Toyota", model: "Camry",
    color: "Blue", vsize: "LightDuty", source: "google"
  };
}
function goodFleet() {
  var b = goodIndividual();
  b.customerType = "fleet";
  b.companyName = "Acme Corp";
  return b;
}

test("valid individual passes", function() {
  assert.strictEqual(validateCheckin(goodIndividual()), null);
});

test("valid fleet passes", function() {
  assert.strictEqual(validateCheckin(goodFleet()), null);
});

test("individual missing lastName fails", function() {
  var b = goodIndividual(); delete b.lastName;
  assert.match(validateCheckin(b), /firstName and lastName/);
});

test("fleet missing companyName fails", function() {
  var b = goodFleet(); delete b.companyName;
  assert.match(validateCheckin(b), /companyName/);
});

test("bad year fails", function() {
  var b = goodIndividual(); b.year = "banana";
  assert.match(validateCheckin(b), /year/);
  b.year = "1850";
  assert.match(validateCheckin(b), /year/);
});

test("short phone fails, formatted phone passes", function() {
  var b = goodIndividual(); b.phone = "555-0123";
  assert.match(validateCheckin(b), /phone/);
  b.phone = "(403) 555-0123";
  assert.strictEqual(validateCheckin(b), null);
});

test("fleet payload never contains firstName/lastName", function() {
  var p = buildCustomerPayload(goodFleet());
  assert.strictEqual(p.customerType, "Fleet");
  assert.strictEqual(p.companyName, "Acme Corp");
  assert.ok(!("firstName" in p), "firstName must be absent for fleet");
  assert.ok(!("lastName" in p), "lastName must be absent for fleet");
});

test("individual payload contains names, no companyName", function() {
  var p = buildCustomerPayload(goodIndividual());
  assert.strictEqual(p.customerType, "Customer");
  assert.strictEqual(p.firstName, "Jane");
  assert.strictEqual(p.lastName, "Doe");
  assert.ok(!("companyName" in p));
});

test("phone/email are arrays with primary flag", function() {
  var p = buildCustomerPayload(goodIndividual());
  assert.deepStrictEqual(p.emails, [{ email: "jane@example.com", primary: true }]);
  assert.deepStrictEqual(p.phoneNumbers, [{ number: "403-555-0123", primary: true }]);
});

test("declaration is server-side and mentions the key terms", function() {
  assert.match(srv.DECLARATION, /valid insurance and registration/);
  assert.match(srv.DECLARATION, /\$20 per day plus tax/);
  assert.match(srv.DECLARATION, /5 days/);
});
