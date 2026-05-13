# Hay Day Farm Tracker – Global Pool & Town Upgrades

A dual‑interface web app to track upgrade materials for **Silo**, **Barn**, **Expansion**, **Town Service Buildings**, and the **Personal Train** in Hay Day.  
Uses a **global pool** logic: the needed amount for each farm is calculated as `totalCurrent(all farms) − farmLevel`.  
Surplus (`+X`) means you can move items to another farm; deficit (`‑X`) means you still need more.

## ✨ Features

- **Multiple farms** – Add, rename, or delete farms. All data saved in your browser (localStorage).
- **Global pool logic** – See at a glance which farm has extra materials and which needs them.
- **All upgrade paths in one place**:
  - Silo, Barn, Expansion (9 materials)
  - Town Service Buildings (9 buildings, 12 materials) – each building has a level input and uses **three materials** from a fixed list.
  - Personal Train (5 bars) – requirements follow the official Hay Day Wiki table for levels 2–19; higher levels are extrapolated.
- **Desktop & mobile versions** – Two separate HTML files share the same localStorage key. Use the wide table on desktop, switch to the card‑based mobile view on your phone.
- **Product lookup** – Search ingredients (e.g., “bread”) to see which recipes use them.

## 🖥️ Desktop vs. Mobile

| Desktop (`hayday_tracker.html`) | Mobile (`hayday_mobile.html`) |
|--------------------------------|-------------------------------|
| Wide table, all farms side by side | One farm at a time, dropdown selector |
| “Current / Level” and “Needed” columns | Simplified “Current” and “Needed” |
| Best for planning moves between farms | Best for quick input on a phone |

**Data is shared** – changes made on one are instantly available on the other (same browser).

## 🧮 Global Pool Logic (Example)

Three farms:  
- Farm A: Silo level 48, has 20 Nails.  
- Farm B: Silo level 50, has 10 Nails.  
- Farm C: Silo level 30, has 30 Nails.  

Total Nails = 20+10+30 = 60.  
Needed for Farm A = 60 − 48 = **+12** (surplus → can move away).  
Needed for Farm B = 60 − 50 = **+10** (surplus).  
Needed for Farm C = 60 − 30 = **+30** (surplus).  

If a farm shows **‑5**, you need 5 more items globally to upgrade that farm.

## 🚀 How to Use

1. Download both HTML files (desktop + mobile) into the same folder.
2. Open either file in a web browser (Chrome, Safari, Firefox).
3. Add your farms, set their levels (Silo, Barn, Expansion, Train, Town Buildings).
4. Enter the current amounts of each material you have.
5. The table shows surplus/deficit. Move items between farms until all needed numbers are zero or positive.

## 🛠️ Tech Stack

- HTML5, Tailwind CSS, Font Awesome 6
- Vanilla JavaScript (no build step)
- localStorage for persistence

## 📁 Files

- `hayday_tracker.html` – Desktop version (full table)
- `hayday_mobile.html` – Mobile‑friendly version
- `README.md` – This file

## 📌 Notes

- The Personal Train requirement table for levels 20+ is extrapolated from the level 2–19 pattern (repeats every 3 levels). If official data for higher levels becomes available, you can edit the `getTrainRequirements()` function.
- All data stays in your browser. No cloud storage or external servers.

## 🤝 Contributing

Feel free to fork and improve. Pull requests for bug fixes or additional Hay Day features (e.g., Fishing Area, Town Reputation) are welcome.

## 📄 License

MIT – use it, share it, tweak it.

---

Happy farming! 🌽🚜