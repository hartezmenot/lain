/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: { brand: '#6366f1', ink: '#111827' },
      borderRadius: { card: '12px' },
    },
  },
};
