const heatmap = document.querySelector("#activity-heatmap");
const tooltip = document.querySelector("#heatmap-tooltip");
const startDate = new Date("2026-01-01T00:00:00");
const featuredIndex = 133;

const formatDate = (date) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);

const getLevel = (index) => {
  const wave = Math.sin(index * 0.43) + Math.cos(index * 0.19);
  if (index > 221) return 0;
  if (index % 23 === 0 || index % 31 === 0) return 4;
  if (wave > 1.18) return 3;
  if (wave > 0.42) return 2;
  if (wave > -0.18 && index % 3 === 0) return 1;
  return 0;
};

for (let index = 0; index < 371; index += 1) {
  const cell = document.createElement("span");
  const date = new Date(startDate);
  date.setDate(startDate.getDate() + index);
  const level = getLevel(index);
  const actions = level === 0 ? 0 : Math.min(5, level + (index % 2));
  const dailyReturn = (((index * 17) % 143) / 100 - 0.41).toFixed(2);

  cell.className = "heat-cell";
  cell.dataset.level = String(level);
  cell.dataset.date = formatDate(date);
  cell.dataset.actions = String(actions);
  cell.dataset.return = dailyReturn;
  cell.setAttribute(
    "aria-label",
    `${cell.dataset.date}: ${actions} investing actions, portfolio ${Number(dailyReturn) >= 0 ? "+" : ""}${dailyReturn}%`,
  );

  if (index === featuredIndex) {
    cell.classList.add("featured");
  }

  cell.addEventListener("mouseenter", () => {
    tooltip.querySelector("span").textContent = cell.dataset.date;
    tooltip.querySelector("strong").textContent = `${cell.dataset.actions} investing action${cell.dataset.actions === "1" ? "" : "s"}`;
    tooltip.querySelector("em").textContent = `Portfolio ${Number(cell.dataset.return) >= 0 ? "+" : ""}${cell.dataset.return}%`;
    tooltip.classList.add("visible");

    const cellBox = cell.getBoundingClientRect();
    const frameBox = cell.closest(".heatmap-frame").getBoundingClientRect();
    const x = cellBox.left - frameBox.left + cellBox.width / 2;
    tooltip.style.left = `${Math.max(90, Math.min(frameBox.width - 90, x))}px`;
    tooltip.style.top = `${Math.max(37, cellBox.top - frameBox.top - 53)}px`;
  });

  cell.addEventListener("mouseleave", () => {
    tooltip.classList.remove("visible");
  });

  heatmap.appendChild(cell);
}

document.querySelectorAll(".period-switcher button, .segmented-control button").forEach((button) => {
  button.addEventListener("click", () => {
    button.parentElement.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  });
});
