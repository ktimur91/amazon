/** @type {import('tailwindcss').Config} */
export default {
  prefix: "tw-",
  content: ["./index.html", "./src/**/*.{vue,js,ts,jsx,tsx,html}"],
  theme: {
    extend: {},
  },
  // Preflight (base reset) is enabled. It only affects elements inside our
  // Shadow DOM (content script) and inside the popup document — never the
  // marketplace page, thanks to Shadow DOM CSS isolation.
  plugins: [],
};
