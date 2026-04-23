const appointmentForm = document.getElementById("appointmentForm");
const confirmationMessage = document.getElementById("confirmationMessage");
const dateInput = appointmentForm.elements.date;
const navigationLinks = document.querySelectorAll(".bottom-nav a");
const submitButton = appointmentForm.querySelector("button[type='submit']");
const qrLink = document.querySelector(".qr-link");

const today = new Date();
const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000)
  .toISOString()
  .split("T")[0];
const apiBase =
  window.location.protocol === "file:" && qrLink
    ? new URL(qrLink.getAttribute("href")).origin
    : window.location.origin;

dateInput.min = localDate;

function formatDate(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);

  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function showConfirmation(message, isError = false) {
  confirmationMessage.textContent = message;
  confirmationMessage.classList.add("show");
  confirmationMessage.classList.toggle("is-error", isError);
}

appointmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  submitButton.disabled = true;
  submitButton.textContent = "Saving Appointment...";

  const formData = new FormData(appointmentForm);
  const payload = {
    patientName: formData.get("patientName"),
    phone: formData.get("phone"),
    service: formData.get("service"),
    date: formData.get("date"),
    time: formData.get("time"),
    reason: formData.get("reason"),
  };

  try {
    const response = await fetch(`${apiBase}/api/appointments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Unable to save the appointment.");
    }

    showConfirmation(
      `Thank you, ${data.appointment.patientName}. Your ${data.appointment.service} appointment is booked for ${formatDate(data.appointment.appointmentDate)} at ${data.appointment.appointmentTime}.`,
    );

    appointmentForm.reset();
    dateInput.min = localDate;
  } catch (error) {
    const fallbackMessage = window.location.protocol === "file:"
      ? `Please open the app from ${apiBase} instead of directly from the file.`
      : error.message;
    showConfirmation(fallbackMessage, true);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Confirm Appointment";
  }
});

navigationLinks.forEach((link) => {
  link.addEventListener("click", () => {
    navigationLinks.forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
  });
});
