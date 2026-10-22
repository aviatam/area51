# Compatibility hooks for older setup scripts. Area51 sends no inherited telemetry.
ph_install_id() { return 0; }
ph_event() { return 0; }
