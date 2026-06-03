"""
VaseLife Report Generator - File Upload Version
For deployment (GitHub, cloud, etc.)
Users upload Excel file and logo via web interface
"""

import sys
import subprocess
import os

# ─── CHECK DEPENDENCIES FIRST (before any other imports) ───────────────────

print("\nChecking dependencies...")

try:
    import flask
    print("  flask: OK")
except ImportError:
    print("  flask: NOT FOUND - installing...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "flask"])

try:
    import openpyxl
    print("  openpyxl: OK")
except ImportError:
    print("  openpyxl: NOT FOUND - installing...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openpyxl"])

try:
    result = subprocess.run(["node", "--version"], capture_output=True)
    if result.returncode != 0:
        print("  ERROR: Node.js not found. Install from https://nodejs.org/")
        sys.exit(1)
    print("  node: OK")
except FileNotFoundError:
    print("  ERROR: Node.js not found. Install from https://nodejs.org/")
    sys.exit(1)

try:
    result = subprocess.run(["npm", "list", "-g", "docx"], capture_output=True, text=True)
    if result.returncode == 0:
        print("  docx: OK")
    else:
        print("  docx: NOT FOUND - installing...")
        subprocess.check_call(["npm", "install", "-g", "docx"])
except FileNotFoundError:
    print("  ERROR: npm not found")
    sys.exit(1)

print("All dependencies OK.\n")

# ─── NOW SAFE TO IMPORT EVERYTHING ELSE ──────────────────────────────────────

import argparse
import threading
import webbrowser
import json
import tempfile
from datetime import datetime
from flask import Flask, request, jsonify, send_file, render_template_string
from collections import defaultdict

# ─── FLASK APP ────────────────────────────────────────────────────────────────

app = Flask(__name__)
UPLOAD_DIR = tempfile.mkdtemp()

# Global state for uploaded files
CURRENT_EXCEL = None
CURRENT_LOGO = None

# ─── DATA LOADING ────────────────────────────────────────────────────────────

def load_data():
    """Load Excel data from uploaded file."""
    if not CURRENT_EXCEL:
        raise ValueError("No Excel file uploaded")
    wb = openpyxl.load_workbook(CURRENT_EXCEL, read_only=True, data_only=True)
    ws = wb.active
    
    header_row_idx = None
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if row[0] == "Test reason":
            header_row_idx = i
            headers = list(row)
            break
    
    if header_row_idx is None:
        raise ValueError("Could not find header row")
    
    data = []
    for row in ws.iter_rows(min_row=header_row_idx + 2, values_only=True):
        if row[0] is None:
            continue
        row_dict = {headers[j]: row[j] for j in range(min(len(headers), len(row)))}
        data.append(row_dict)
    
    wb.close()
    return headers, data

def get_calculated_col_indices(headers):
    """Get pre-calculated botrytis columns from Excel."""
    return {"pct_bot": 65, "num_lt7": 67, "pct_lt7": 68}

# ─── ROUTES ──────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route("/api/upload", methods=["POST"])
def upload_files():
    """Handle file uploads."""
    global CURRENT_EXCEL, CURRENT_LOGO
    try:
        if "excel_file" not in request.files:
            return jsonify({"error": "No Excel file"}), 400
        
        excel_file = request.files["excel_file"]
        if excel_file.filename == "":
            return jsonify({"error": "No file selected"}), 400
        
        excel_path = os.path.join(UPLOAD_DIR, "data.xlsm")
        excel_file.save(excel_path)
        CURRENT_EXCEL = excel_path
        
        logo_file = request.files.get("logo_file")
        if logo_file and logo_file.filename != "":
            logo_path = os.path.join(UPLOAD_DIR, "logo.png")
            logo_file.save(logo_path)
            CURRENT_LOGO = logo_path
        
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/growers")
def get_growers():
    """Get unique grower names from data."""
    try:
        headers, data = load_data()
        growers = sorted(set(
            str(row.get("Grower", "")).strip()
            for row in data
            if row.get("Grower")
        ))
        return jsonify({"growers": [g for g in growers if g]})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/periods")
def get_periods():
    """Get unique (year, month) periods from data."""
    try:
        headers, data = load_data()
        periods = set()
        for row in data:
            d = row.get("Storage date")
            if isinstance(d, datetime):
                periods.add((d.year, d.month))
        sorted_periods = sorted(periods, reverse=True)
        result = [
            {"value": f"{y}-{m:02d}", "label": datetime(y, m, 1).strftime("%B %Y")}
            for y, m in sorted_periods
        ]
        return jsonify({"periods": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/generate", methods=["POST"])
def generate_report():
    """Generate Word report."""
    try:
        body = request.get_json()
        selected_growers = body.get("growers", [])
        selected_period = body.get("period", "")
        include_variants = body.get("include_variants", False)
        
        if not selected_growers or not selected_period:
            return jsonify({"error": "Missing growers or period"}), 400
        
        year, month = map(int, selected_period.split("-"))
        period_label = datetime(year, month, 1).strftime("%B %Y")
        
        headers, data = load_data()
        calc_cols = get_calculated_col_indices(headers)
        
        EXCLUDED_REASONS = {"Vaselife/Research"}
        
        def grower_matches(grower_val):
            g = str(grower_val).strip() if grower_val else ""
            for sel in selected_growers:
                if include_variants:
                    if g.lower().startswith(sel.lower()):
                        return True
                else:
                    if g.lower() == sel.lower():
                        return True
            return False
        
        filtered = []
        for row in data:
            if row.get("Test reason") in EXCLUDED_REASONS:
                continue
            d = row.get("Storage date")
            if not isinstance(d, datetime):
                continue
            if d.year != year or d.month != month:
                continue
            if not grower_matches(row.get("Grower")):
                continue
            filtered.append(row)
        
        if not filtered:
            return jsonify({"error": f"No data found for selected filters"}), 404
        
        # Aggregation
        def safe_avg(values):
            vals = [v for v in values if v is not None and isinstance(v, (int, float))]
            return round(sum(vals) / len(vals), 2) if vals else None
        
        def calc_pct_lt7(rows):
            vals = [r.get("%<7") for r in rows if r.get("%<7") is not None and isinstance(r.get("%<7"), (int, float))]
            return round(sum(vals) / len(vals), 1) if vals else None
        
        def calc_avg_botrytis_pct(rows):
            vals = [r.get("% bot") for r in rows if r.get("% bot") is not None and isinstance(r.get("% bot"), (int, float))]
            return round(sum(vals) / len(vals), 1) if vals else 0.0
        
        subgroup_data = defaultdict(lambda: defaultdict(list))
        for row in filtered:
            sg = str(row.get("Subgroup") or "Unknown").strip()
            variety = str(row.get("Variety") or "Unknown").strip()
            colour = str(row.get("Colour") or "").strip()
            subgroup_data[sg][(variety, colour)].append(row)
        
        report_data = {}
        variety_subgroup_map = defaultdict(list)
        for sg, varieties in subgroup_data.items():
            report_data[sg] = []
            for (variety, colour), rows in varieties.items():
                entry = {
                    "variety": variety, "colour": colour, "num_tests": len(rows),
                    "avg_cts": safe_avg([r.get("Average CTS") for r in rows]),
                    "avg_vaselife": safe_avg([r.get("Average vaselife") for r in rows]),
                    "pct_lt7": calc_pct_lt7(rows),
                    "avg_botrytis": calc_avg_botrytis_pct(rows),
                }
                report_data[sg].append(entry)
                variety_subgroup_map[variety].append(sg)
        
        multi = {v: sgs for v, sgs in variety_subgroup_map.items() if len(set(sgs)) > 1}
        
        overall = {
            "total_vases": len(filtered),
            "avg_cts": safe_avg([r.get("Average CTS") for r in filtered]),
            "avg_vaselife": safe_avg([r.get("Average vaselife") for r in filtered]),
            "pct_lt7": calc_pct_lt7(filtered),
            "avg_botrytis": calc_avg_botrytis_pct(filtered),
        }
        
        grower_display = ", ".join(selected_growers)
        report_payload = {
            "grower": grower_display,
            "period": period_label,
            "overall": overall,
            "subgroups": report_data,
            "multi_subgroup_varieties": multi,
            "logo_path": CURRENT_LOGO if CURRENT_LOGO and os.path.exists(CURRENT_LOGO) else None,
        }
        
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(report_payload, f, default=str)
            payload_path = f.name
        
        output_path = tempfile.mktemp(suffix=".docx")
        result = subprocess.run(
            ["node", os.path.join(os.path.dirname(__file__), "generate_report.js"), payload_path, output_path],
            capture_output=True, text=True
        )
        os.unlink(payload_path)
        
        if result.returncode != 0:
            return jsonify({"error": f"Report generation failed: {result.stderr}"}), 500
        
        grower_slug = selected_growers[0].replace(" ", "_")
        filename = f"VaseLife_{grower_slug}_{period_label.replace(' ', '_')}.docx"
        
        return send_file(
            output_path, as_attachment=True, download_name=filename,
            mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
    
    except Exception as e:
        import traceback
        return jsonify({"error": str(e)}), 500

# ─── HTML TEMPLATE ────────────────────────────────────────────────────────────

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VaseLife Report Generator</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #f5f5f5; }
  .header { background: #1a5276; color: white; padding: 30px; text-align: center; }
  .header h1 { font-size: 28px; margin-bottom: 6px; }
  .header p { font-size: 14px; opacity: 0.9; }
  .container { max-width: 600px; margin: 30px auto; background: white; border-radius: 6px; box-shadow: 0 1px 8px rgba(0,0,0,0.08); padding: 32px; }
  .section { margin-bottom: 28px; }
  .section-title { font-size: 12px; font-weight: 700; color: #1a5276; text-transform: uppercase; margin-bottom: 14px; letter-spacing: 0.5px; }
  label { font-size: 13px; font-weight: 600; color: #333; display: block; margin-bottom: 8px; }
  input[type="file"], select { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; font-family: inherit; }
  input[type="file"] { cursor: pointer; }
  select { background: white; cursor: pointer; }
  .multi-select { height: 140px; }
  .hint { font-size: 12px; color: #666; margin-top: 6px; }
  .checkbox { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .checkbox input { width: 16px; height: 16px; cursor: pointer; }
  .checkbox label { margin: 0; font-weight: 500; cursor: pointer; }
  .btn { background: #1a5276; color: white; border: none; padding: 12px; border-radius: 4px; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; transition: background 0.2s; }
  .btn:hover:not(:disabled) { background: #154360; }
  .btn:disabled { background: #ccc; cursor: not-allowed; }
  .status { margin-top: 16px; padding: 12px 16px; border-radius: 4px; font-size: 13px; display: none; }
  .status.error { background: #fee; color: #c00; border: 1px solid #fcc; }
  .status.success { background: #efe; color: #040; border: 1px solid #cfc; }
  .status.loading { background: #eef; color: #05a; border: 1px solid #ccf; }
  .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #05a; border-top-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; margin-right: 8px; vertical-align: -2px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #selectSection { display: none; }
</style>
</head>
<body>
<div class="header">
  <h1>VaseLife Report Generator</h1>
  <p>The Floral Connection</p>
</div>

<div class="container">
  <div class="section">
    <div class="section-title">1. Upload Files</div>
    <label>Excel File *</label>
    <input type="file" id="excelFile" accept=".xlsx,.xlsm" />
    <div class="hint">Vase_Life_database.xlsx</div>
    
    <label style="margin-top: 16px;">Logo (optional)</label>
    <input type="file" id="logoFile" accept=".png,.jpg,.jpeg" />
    <div class="hint">PNG or JPG</div>
    
    <button class="btn" onclick="uploadFiles()" style="margin-top: 16px;">Upload & Continue</button>
  </div>

  <div id="selectSection" class="section">
    <div class="section-title">2. Generate Report</div>
    
    <label>Grower(s) *</label>
    <select id="growerSelect" class="multi-select" multiple>
      <option disabled>Loading...</option>
    </select>
    <div class="hint">Hold Ctrl/Cmd to select multiple</div>
    
    <div class="checkbox">
      <input type="checkbox" id="includeVariants" />
      <label for="includeVariants">Include variants (Nini-T1, etc.)</label>
    </div>

    <label style="margin-top: 16px;">Period *</label>
    <select id="periodSelect">
      <option disabled selected>Select...</option>
    </select>

    <button class="btn" onclick="generateReport()" style="margin-top: 24px;">Generate Report</button>
  </div>

  <div class="status" id="status"></div>
</div>

<script>
  async function uploadFiles() {
    const excel = document.getElementById("excelFile").files[0];
    const logo = document.getElementById("logoFile").files[0];
    
    if (!excel) {
      showStatus("Select an Excel file", "error");
      return;
    }
    
    const form = new FormData();
    form.append("excel_file", excel);
    if (logo) form.append("logo_file", logo);
    
    showStatus("Uploading...", "loading");
    
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      
      if (!res.ok) {
        showStatus("Error: " + (data.error || "Upload failed"), "error");
        return;
      }
      
      await loadDropdowns();
      document.getElementById("selectSection").style.display = "block";
      showStatus("Files uploaded!", "success");
      setTimeout(() => { document.getElementById("status").style.display = "none"; }, 2000);
    } catch (e) {
      showStatus("Upload failed: " + e.message, "error");
    }
  }

  async function loadDropdowns() {
    try {
      const [gRes, pRes] = await Promise.all([fetch("/api/growers"), fetch("/api/periods")]);
      const gData = await gRes.json();
      const pData = await pRes.json();

      document.getElementById("growerSelect").innerHTML = "";
      gData.growers.forEach(g => {
        const o = document.createElement("option");
        o.value = g;
        o.textContent = g;
        document.getElementById("growerSelect").appendChild(o);
      });

      document.getElementById("periodSelect").innerHTML = "";
      pData.periods.forEach(p => {
        const o = document.createElement("option");
        o.value = p.value;
        o.textContent = p.label;
        document.getElementById("periodSelect").appendChild(o);
      });
    } catch (e) {
      showStatus("Failed to load: " + e.message, "error");
    }
  }

  function showStatus(msg, type) {
    const el = document.getElementById("status");
    el.style.display = "block";
    el.className = "status " + type;
    el.innerHTML = type === "loading" ? `<span class="spinner"></span>${msg}` : msg;
  }

  async function generateReport() {
    const growers = Array.from(document.getElementById("growerSelect").selectedOptions).map(o => o.value);
    const period = document.getElementById("periodSelect").value;
    
    if (!growers.length) { showStatus("Select a grower", "error"); return; }
    if (!period) { showStatus("Select a period", "error"); return; }
    
    showStatus("Generating report...", "loading");
    
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ growers, period, include_variants: document.getElementById("includeVariants").checked })
      });

      if (!res.ok) {
        const err = await res.json();
        showStatus("Error: " + (err.error || "Failed"), "error");
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="?([^"]+)"?/);
      a.download = match ? match[1] : "VaseLife_Report.docx";
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
      showStatus("Downloaded!", "success");
    } catch (e) {
      showStatus("Error: " + e.message, "error");
    }
  }
</script>
</body>
</html>
"""

# ─── STARTUP ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = 5050
    url = f"http://localhost:{port}"
    print(f"\nVaseLife Report Generator")
    print(f"Opening: {url}\n")
    
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    app.run(port=port, debug=False)