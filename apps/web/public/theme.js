// Applies the saved/OS theme before first paint (external file so the CSP needs no inline scripts).
try {
  var t = localStorage.getItem('kdp-theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) {}
