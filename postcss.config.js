import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

// Convert every `rem` value to an absolute `px` (1rem = 16px) AFTER Tailwind
// has generated its utilities. The content-script UI lives in a Shadow DOM, but
// `rem` is always resolved against the HOST PAGE's <html> font-size — which
// Shopee enlarges for its own responsive layout, blowing our panel up. Pinning
// to px makes the panel render identically regardless of the page's root size.
const ROOT_FONT_PX = 16;
const remToPx = () => ({
  postcssPlugin: "rem-to-px",
  Declaration(decl) {
    if (!decl.value.includes("rem")) return;
    decl.value = decl.value.replace(
      /(-?\d*\.?\d+)rem\b/g,
      (_, n) => `${parseFloat(n) * ROOT_FONT_PX}px`,
    );
  },
});
remToPx.postcss = true;

export default {
  // Order matters: Tailwind expands utilities first, then rem-to-px rewrites
  // the generated rem values to px.
  plugins: [tailwindcss(), autoprefixer(), remToPx()],
};

