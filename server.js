const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const { DatabaseSync } = require("node:sqlite");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const ROOT_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : ROOT_DIR;
const DATABASE_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(DATA_DIR, "appointments.db");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PROTECTED_ADMIN_PATHS = new Set([
  "/admin",
  "/admin.html",
  "/admin.js",
]);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const SAFE_STATIC_FILES = new Set([
  ".css",
  ".html",
  ".jpg",
  ".jpeg",
  ".js",
  ".png",
  ".svg",
]);

fsSync.mkdirSync(path.dirname(DATABASE_PATH), {
  recursive: true,
});

const db = new DatabaseSync(DATABASE_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    service TEXT NOT NULL,
    appointment_date TEXT NOT NULL,
    appointment_time TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
  )
`);

const insertAppointmentStatement = db.prepare(`
  INSERT INTO appointments (
    patient_name,
    phone,
    service,
    appointment_date,
    appointment_time,
    reason,
    status,
    created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const recentAppointmentsStatement = db.prepare(`
  SELECT
    id,
    patient_name AS patientName,
    phone,
    service,
    appointment_date AS appointmentDate,
    appointment_time AS appointmentTime,
    reason,
    status,
    created_at AS createdAt
  FROM appointments
  ORDER BY created_at DESC, id DESC
  LIMIT 20
`);

const appointmentByIdStatement = db.prepare(`
  SELECT
    id,
    patient_name AS patientName,
    phone,
    service,
    appointment_date AS appointmentDate,
    appointment_time AS appointmentTime,
    reason,
    status,
    created_at AS createdAt
  FROM appointments
  WHERE id = ?
`);

const appointmentCountStatement = db.prepare(`
  SELECT COUNT(*) AS totalAppointments
  FROM appointments
`);

const sseClients = new Set();
const API_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...API_CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(message),
  });
  response.end(message);
}

function sanitizeString(value) {
  return String(value ?? "").trim();
}

function secureEquals(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuthHeader(authorizationHeader) {
  if (!authorizationHeader?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(authorizationHeader.slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex === -1) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch (error) {
    return null;
  }
}

function requireAdminAuth(request, response) {
  if (!ADMIN_PASSWORD) {
    return true;
  }

  const credentials = parseBasicAuthHeader(request.headers.authorization);

  if (
    credentials &&
    secureEquals(credentials.username, ADMIN_USERNAME) &&
    secureEquals(credentials.password, ADMIN_PASSWORD)
  ) {
    return true;
  }

  response.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "WWW-Authenticate": 'Basic realm="Clinic Admin"',
  });
  response.end("Admin login required.");
  return false;
}

function parseRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;

      if (size > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      resolve(body);
    });

    request.on("error", reject);
  });
}

function normalizeAppointment(record) {
  return {
    ...record,
    id: Number(record.id),
  };
}

function getDashboardPayload() {
  const totalAppointments = Number(appointmentCountStatement.get().totalAppointments);
  const appointments = recentAppointmentsStatement.all().map(normalizeAppointment);

  return {
    totalAppointments,
    appointments,
  };
}

function broadcast(eventName, payload) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;

  for (const client of sseClients) {
    client.write(message);
  }
}

async function serveStaticAsset(requestPath, response) {
  const relativePath = requestPath === "/"
    ? "index.html"
    : requestPath === "/admin"
      ? "admin.html"
      : requestPath.slice(1);
  const fullPath = path.resolve(ROOT_DIR, relativePath);
  const extension = path.extname(fullPath).toLowerCase();

  if (!fullPath.startsWith(ROOT_DIR) || !SAFE_STATIC_FILES.has(extension)) {
    sendText(response, 404, "Not found");
    return;
  }

  try {
    const file = await fs.readFile(fullPath);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "Content-Length": file.length,
    });
    response.end(file);
  } catch (error) {
    sendText(response, 404, "Not found");
  }
}

async function handleAppointmentsPost(request, response) {
  try {
    const rawBody = await parseRequestBody(request);
    const payload = JSON.parse(rawBody || "{}");

    const patientName = sanitizeString(payload.patientName);
    const phone = sanitizeString(payload.phone);
    const service = sanitizeString(payload.service);
    const appointmentDate = sanitizeString(payload.date);
    const appointmentTime = sanitizeString(payload.time);
    const reason = sanitizeString(payload.reason);

    if (!patientName || !phone || !service || !appointmentDate || !appointmentTime || !reason) {
      sendJson(response, 400, {
        message: "Please fill in all required appointment details.",
      });
      return;
    }

    const createdAt = new Date().toISOString();
    const result = insertAppointmentStatement.run(
      patientName,
      phone,
      service,
      appointmentDate,
      appointmentTime,
      reason,
      "new",
      createdAt,
    );

    const appointmentId = Number(result.lastInsertRowid);
    const appointment = normalizeAppointment(appointmentByIdStatement.get(appointmentId));
    const dashboard = getDashboardPayload();

    console.log(
      `[BOOKING] ${appointment.patientName} booked ${appointment.service} for ${appointment.appointmentDate} at ${appointment.appointmentTime}`,
    );

    broadcast("appointment-created", {
      appointment,
      totalAppointments: dashboard.totalAppointments,
    });

    sendJson(response, 201, {
      message: `Appointment saved for ${appointment.patientName}.`,
      appointment,
      totalAppointments: dashboard.totalAppointments,
    });
  } catch (error) {
    console.error("[BOOKING ERROR]", error);
    sendJson(response, 500, {
      message: "Unable to save the appointment right now.",
    });
  }
}

function handleNotifications(request, response) {
  response.writeHead(200, {
    ...API_CORS_HEADERS,
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
  });

  response.write(`event: connected\ndata: ${JSON.stringify(getDashboardPayload())}\n\n`);
  sseClients.add(response);

  request.on("close", () => {
    sseClients.delete(response);
  });
}

const heartbeatInterval = setInterval(() => {
  for (const client of sseClients) {
    client.write(": heartbeat\n\n");
  }
}, 20_000);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
    response.writeHead(204, API_CORS_HEADERS);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/appointments") {
    if (!requireAdminAuth(request, response)) {
      return;
    }

    sendJson(response, 200, getDashboardPayload());
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      databasePath: DATABASE_PATH,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/notifications") {
    if (!requireAdminAuth(request, response)) {
      return;
    }

    handleNotifications(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/appointments") {
    await handleAppointmentsPost(request, response);
    return;
  }

  if (request.method === "GET") {
    if (PROTECTED_ADMIN_PATHS.has(url.pathname) && !requireAdminAuth(request, response)) {
      return;
    }

    await serveStaticAsset(url.pathname, response);
    return;
  }

  sendText(response, 405, "Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`Clinic app server is running at http://localhost:${PORT}`);
  console.log(`Appointments database: ${DATABASE_PATH}`);
});

function shutdown() {
  clearInterval(heartbeatInterval);

  for (const client of sseClients) {
    client.end();
  }

  db.close();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
