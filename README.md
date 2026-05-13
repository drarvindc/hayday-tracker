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
- **Desktop & mobile versions** – Two separate HTML files share the same data via GitHub Gist sync. Use the wide table on desktop, switch to the card‑based mobile view on your phone.
- **Automatic device detection** – The correct version loads automatically based on your device. A manual toggle button lets you override at any time.
- **Product lookup** – Search ingredients (e.g., “bread”) to see which recipes use them.
- **Cross‑device sync** – Share data between devices via a GitHub Gist (configurable in the Sync Settings modal).

## 🖥️ Desktop vs. Mobile

| Desktop (`hayday_tracker.html`) | Mobile (`hayday_mobile.html`) |
|--------------------------------|-------------------------------|
| Wide table, all farms side by side | One farm at a time, dropdown selector |
| “Current / Level” and “Needed” columns | Simplified “Current” and “Needed” |
| Best for planning moves between farms | Best for quick input on a phone |

**Data is shared** – changes made on one are instantly available on the other (same browser or synced via Gist).

### 🔗 Cross‑Linking (Automatic Device Detection + Manual Override)

The two versions are linked together so that the right page loads automatically:

- **Auto‑detection** – When you first visit from a phone (Android, iPhone, iPad, etc.), the page automatically redirects to the mobile version. Desktop visitors stay on the desktop version.
- **Manual override** – A small button in the top‑right corner lets you switch versions at any time (📱 Switch to Mobile / 💻 Switch to Desktop).
- **Saved preference** – Once you click the override button, your choice is saved in `localStorage`. Future visits will respect your manual choice and skip auto‑detection.

To disable auto‑redirect completely, a user can simply click the toggle button once to lock in their preferred version.

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
6. (Optional) Configure Sync Settings with a GitHub Gist to share data across devices.

## 🛠️ Tech Stack

- HTML5, Tailwind CSS, Font Awesome 6
- Vanilla JavaScript (no build step)
- localStorage for persistence
- GitHub Gist API (optional, for cross‑device sync)
- Apache .htaccess (optional, for password protection)

## 📁 Files

- `hayday_tracker.html` – Desktop version (full table)
- `hayday_mobile.html` – Mobile‑friendly version
- `htaccess.txt` – Password protection template (rename to `.htaccess` to activate)
- `README.md` – This file

## 🔐 Securing the Page (Password Protection)

To restrict access to the tracker, a pre‑configured `.htaccess` template is included:

1. Open `htaccess.txt` and rename it to **`.htaccess`** (note the leading dot).
2. **Default credentials** – username `admin`, password `hayday2024`.
3. Generate a `.htpasswd` file – the `htaccess.txt` file includes several methods (online generator, Node.js, Python).
4. Place the `.htpasswd` file in the same directory and update the `AuthUserFile` path in `.htaccess` to point to it.
5. Once both files are in place, visitors will be prompted for a username and password before viewing the tracker.

> ⚠️ **Important:** `.htaccess` works only on Apache web servers. If you're testing locally without a server, password protection will have no effect.

## 📌 Notes

- The Personal Train requirement table for levels 20+ is extrapolated from the level 2–19 pattern (repeats every 3 levels). If official data for higher levels becomes available, you can edit the `getTrainRequirements()` function.
- All data stays in your browser. No cloud storage or external servers (unless you configure GitHub Gist sync).
- The cross‑linking script uses a regular expression to detect mobile devices. If your device is not detected correctly, use the manual toggle button.

## 🤝 Contributing

Feel free to fork and improve. Pull requests for bug fixes or additional Hay Day features (e.g., Fishing Area, Town Reputation) are welcome.

## 📄 License

MIT – use it, share it, tweak it.

---

Happy farming! 🌽🚜