# backend/src/share/page.py
"""Returns the self-contained HTML string for the share page."""


def build_share_page(token: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>UIUC Bustle \u2014 Trip Share</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; min-height: 100vh; }}
    .header {{ background: #13294B; color: white; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; }}
    .header-title {{ font-size: 17px; font-weight: 700; letter-spacing: 0.3px; }}
    .live-dot {{ width: 8px; height: 8px; border-radius: 50%; background: #4ade80; animation: pulse 1.5s infinite; }}
    @keyframes pulse {{ 0%, 100% {{ opacity: 1; }} 50% {{ opacity: 0.3; }} }}
    .card {{ background: white; border-radius: 16px; margin: 16px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }}
    .label {{ font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }}
    .destination {{ font-size: 28px; font-weight: 800; color: #13294B; line-height: 1.2; margin-bottom: 20px; }}
    .phase-pill {{ display: inline-flex; align-items: center; gap: 7px; padding: 7px 14px; border-radius: 20px; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px; }}
    .phase-dot {{ width: 8px; height: 8px; border-radius: 50%; }}
    .phase-walking {{ background: #f3f4f6; color: #6B7280; }} .phase-walking .phase-dot {{ background: #6B7280; }}
    .phase-waiting {{ background: #fef3c7; color: #D97706; }} .phase-waiting .phase-dot {{ background: #D97706; }}
    .phase-on_bus {{ background: #dcfce7; color: #16A34A; }} .phase-on_bus .phase-dot {{ background: #16A34A; }}
    .phase-arrived {{ background: #13294B; color: white; }} .phase-arrived .phase-dot {{ background: white; }}
    .phase-expired {{ background: #f3f4f6; color: #9ca3af; }} .phase-expired .phase-dot {{ background: #9ca3af; }}
    .eta {{ font-size: 22px; font-weight: 700; color: #13294B; margin-bottom: 6px; }}
    .eta-sub {{ font-size: 15px; color: #6b7280; margin-bottom: 16px; }}
    .stop-row {{ display: flex; align-items: center; gap: 8px; padding-top: 16px; border-top: 1px solid #f3f4f6; color: #6b7280; font-size: 14px; }}
    .footer {{ text-align: center; padding: 20px; color: #9ca3af; font-size: 13px; }}
  </style>
</head>
<body>
  <div class="header">
    <span class="header-title">UIUC Bustle</span>
    <div class="live-dot" id="liveDot"></div>
  </div>
  <div class="card">
    <div class="label">Heading to</div>
    <div class="destination" id="destination">Loading\u2026</div>
    <div class="phase-pill phase-walking" id="phasePill">
      <div class="phase-dot"></div>
      <span id="phaseLabel">\u2014</span>
    </div>
    <div class="eta" id="etaTime"></div>
    <div class="eta-sub" id="etaSub"></div>
    <div class="stop-row" id="stopRow" style="display:none">
      <span>From:</span>
      <strong id="stopName"></strong>
    </div>
  </div>
  <div class="footer">Updates every 15s &middot; UIUC Bustle</div>
  <script>
    var TOKEN = {repr(token)};
    var PHASE_LABELS = {{walking:'Walking to stop',waiting:'Waiting at stop',on_bus:'On bus',arrived:'Arrived \U0001f389'}};
    var PHASE_CLASS = {{walking:'phase-walking',waiting:'phase-waiting',on_bus:'phase-on_bus',arrived:'phase-arrived'}};
    var etaEpoch = null, pollTimer = null, countdownTimer = null;

    function fmt12h(epoch) {{
      var d = new Date(epoch * 1000), h = d.getHours(), m = d.getMinutes();
      var p = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
      return h + ':' + String(m).padStart(2,'0') + ' ' + p;
    }}
    function updateCountdown() {{
      if (!etaEpoch) return;
      var mins = Math.max(0, Math.floor((etaEpoch - Date.now()/1000) / 60));
      document.getElementById('etaSub').textContent = mins <= 0 ? 'Arriving now' : mins + ' min away';
    }}
    function showExpired(msg) {{
      clearInterval(pollTimer); clearInterval(countdownTimer);
      document.getElementById('liveDot').style.background = '#d1d5db';
      document.getElementById('phasePill').className = 'phase-pill phase-expired';
      document.getElementById('phaseLabel').textContent = msg || 'Trip ended';
      document.getElementById('etaTime').textContent = '';
      document.getElementById('etaSub').textContent = '';
    }}
    function applyState(data) {{
      document.getElementById('destination').textContent = data.destination || '\u2014';
      etaEpoch = data.eta_epoch || null;
      var pill = document.getElementById('phasePill');
      pill.className = 'phase-pill ' + (PHASE_CLASS[data.phase] || 'phase-expired');
      var routeInfo = data.route_id ? ('Bus ' + data.route_id + (data.route_name ? ' ' + data.route_name : '')) : '';
      var phaseText = PHASE_LABELS[data.phase] || data.phase;
      document.getElementById('phaseLabel').textContent = routeInfo ? phaseText + ' \u00b7 ' + routeInfo : phaseText;
      if (etaEpoch) {{ document.getElementById('etaTime').textContent = 'ETA ' + fmt12h(etaEpoch); updateCountdown(); }}
      else {{ document.getElementById('etaTime').textContent = ''; document.getElementById('etaSub').textContent = ''; }}
      if (data.stop_name) {{
        document.getElementById('stopRow').style.display = 'flex';
        document.getElementById('stopName').textContent = data.stop_name;
      }}
    }}
    function fetchStatus() {{
      fetch('/share/trips/' + TOKEN + '/status')
        .then(function(r) {{ return r.ok ? r.json() : Promise.reject(r.status); }})
        .then(function(data) {{
          if (data.expired) {{ showExpired('This trip has ended'); return; }}
          applyState(data);
        }})
        .catch(function() {{ showExpired('Trip not found'); }});
    }}
    fetchStatus();
    pollTimer = setInterval(fetchStatus, 15000);
    countdownTimer = setInterval(updateCountdown, 1000);
  </script>
</body>
</html>"""
