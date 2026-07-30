/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#14181C",
        paper: "#EDEFF2",
        card: "#FFFFFF",
        teal: {
          DEFAULT: "#0F6B62",
          dark: "#0B4F49",
        },
        queued: "#E8A33D",
        printing: "#2F6FED",
        ready: "#1F9D6F",
        collected: "#8A94A3",
      },
      fontFamily: {
        display: ["Barlow Condensed", "sans-serif"],
        body: ["Inter", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
