const navigationLinks = document.querySelectorAll(".bottom-nav a");
const liveStatusBadge = document.getElementById("liveStatusBadge");
const appointmentCount = document.getElementById("appointmentCount");
const notificationStatus = document.getElementById("notificationStatus");
const liveFeedStatus = document.getElementById("liveFeedStatus");
const enableNotificationsButton = document.getElementById("enableNotificationsButton");
const appointmentsList = document.getElementById("appointmentsList");
const liveToast = document.getElementById("liveToast");

const appointmentIds = new Set();

let liveToastTimeoutId = null;
let eventSource = null;

function formatDate(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);

  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatCreatedAt(dateValue) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(dateValue));
}

function showLiveToast(message) {
  liveToast.textContent = message;
  liveToast.classList.add("show");

  if (liveToastTimeoutId) {
    window.clearTimeout(liveToastTimeoutId);
  }

  liveToastTimeoutId = window.setTimeout(() => {
    liveToast.classList.remove("show");
  }, 5000);
}

function updateLiveFeed(message, isConnected) {
  liveFeedStatus.textContent = message;
  liveStatusBadge.textContent = isConnected ? "Alerts Live" : "Alerts Offline";
}

function updateNotificationStatusLabel() {
  if (!("Notification" in window)) {
    notificationStatus.textContent = "Not Supported";
    enableNotificationsButton.disabled = true;
    enableNotificationsButton.textContent = "Browser Alerts Unavailable";
    return;
  }

  if (Notification.permission === "granted") {
    notificationStatus.textContent = "Enabled";
    enableNotificationsButton.disabled = true;
    enableNotificationsButton.textContent = "Browser Alerts Enabled";
    return;
  }

  if (Notification.permission === "denied") {
    notificationStatus.textContent = "Blocked";
    enableNotificationsButton.disabled = true;
    enableNotificationsButton.textContent = "Alerts Blocked in Browser";
    return;
  }

  notificationStatus.textContent = "Optional";
}

function createAppointmentElement(appointment) {
  const card = document.createElement("article");
  card.className = "appointment-item";
  card.dataset.appointmentId = String(appointment.id);

  const header = document.createElement("div");
  header.className = "appointment-item-header";

  const title = document.createElement("h4");
  title.textContent = appointment.patientName;

  const timeBadge = document.createElement("span");
  timeBadge.className = "appointment-item-time";
  timeBadge.textContent = `${formatDate(appointment.appointmentDate)} • ${appointment.appointmentTime}`;

  header.append(title, timeBadge);

  const meta = document.createElement("p");
  meta.className = "appointment-meta";
  meta.textContent =
    `${appointment.service} • ${appointment.phone} • Booked ${formatCreatedAt(appointment.createdAt)}`;

  const reason = document.createElement("p");
  reason.className = "appointment-reason";
  reason.textContent = appointment.reason;

  card.append(header, meta, reason);

  return card;
}

function renderEmptyState() {
  appointmentsList.innerHTML = "";
  appointmentIds.clear();

  const emptyState = document.createElement("p");
  emptyState.className = "empty-state";
  emptyState.textContent = "No appointments yet. New patient bookings will appear here automatically.";
  appointmentsList.append(emptyState);
}

function renderAppointments(appointments) {
  appointmentsList.innerHTML = "";
  appointmentIds.clear();

  if (!appointments.length) {
    renderEmptyState();
    return;
  }

  const fragment = document.createDocumentFragment();

  appointments.forEach((appointment) => {
    appointmentIds.add(appointment.id);
    fragment.append(createAppointmentElement(appointment));
  });

  appointmentsList.append(fragment);
}

function prependAppointment(appointment) {
  if (appointmentIds.has(appointment.id)) {
    return;
  }

  const currentEmptyState = appointmentsList.querySelector(".empty-state");

  if (currentEmptyState) {
    currentEmptyState.remove();
  }

  appointmentIds.add(appointment.id);
  appointmentsList.prepend(createAppointmentElement(appointment));

  while (appointmentsList.children.length > 20) {
    const lastChild = appointmentsList.lastElementChild;

    if (lastChild?.dataset.appointmentId) {
      appointmentIds.delete(Number(lastChild.dataset.appointmentId));
    }

    lastChild?.remove();
  }
}

function updateAppointmentCount(total) {
  appointmentCount.textContent = String(total);
}

function notifyClinic(appointment) {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const notification = new Notification("New appointment booked", {
    body: `${appointment.patientName} booked ${appointment.service} for ${formatDate(appointment.appointmentDate)} at ${appointment.appointmentTime}.`,
    tag: `appointment-${appointment.id}`,
  });

  window.setTimeout(() => notification.close(), 8000);
}

async function loadAppointments() {
  try {
    const response = await fetch("/api/appointments");

    if (!response.ok) {
      throw new Error("Unable to load appointments.");
    }

    const data = await response.json();
    updateAppointmentCount(data.totalAppointments);
    renderAppointments(data.appointments);
  } catch (error) {
    renderEmptyState();
    updateLiveFeed("Start the server to receive appointments.", false);
  }
}

function connectLiveFeed() {
  if (!("EventSource" in window)) {
    updateLiveFeed("Live alerts are not supported in this browser.", false);
    return;
  }

  eventSource = new EventSource("/api/notifications");

  eventSource.addEventListener("connected", (event) => {
    const data = JSON.parse(event.data);
    updateAppointmentCount(data.totalAppointments);
    renderAppointments(data.appointments);
    updateLiveFeed("Live booking feed connected.", true);
  });

  eventSource.addEventListener("appointment-created", (event) => {
    const data = JSON.parse(event.data);
    updateAppointmentCount(data.totalAppointments);
    prependAppointment(data.appointment);
    updateLiveFeed("A new booking has arrived.", true);
    showLiveToast(`${data.appointment.patientName} just booked ${data.appointment.service}.`);
    notifyClinic(data.appointment);
  });

  eventSource.onerror = () => {
    updateLiveFeed("Trying to reconnect to the live booking feed...", false);
  };
}

enableNotificationsButton.addEventListener("click", async () => {
  if (!("Notification" in window)) {
    return;
  }

  const permission = await Notification.requestPermission();

  updateNotificationStatusLabel();

  if (permission === "granted") {
    showLiveToast("Browser notifications are now enabled for new appointments.");
  }
});

navigationLinks.forEach((link) => {
  link.addEventListener("click", () => {
    navigationLinks.forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});

updateNotificationStatusLabel();
loadAppointments();
connectLiveFeed();
