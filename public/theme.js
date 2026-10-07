// Apply the saved theme before first paint (no flash). Storage may be unavailable. Kept in a file so the CSP can forbid inline scripts.
try { var t = localStorage.getItem('dummy-emag-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
