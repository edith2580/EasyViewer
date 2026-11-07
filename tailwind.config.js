/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}'
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        sepia: {
          50: '#fdfaf6',
          100: '#f4ecd8',
          200: '#eadbc0',
          300: '#dcc49e',
          700: '#5b4636',
          800: '#433422',
          900: '#2c2216'
        }
      },
      fontFamily: {
        sans: ['"Pretendard Variable"', 'Pretendard', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        serif: ['"Nanum Myeongjo"', '"Noto Serif KR"', 'Georgia', 'serif'],
        mono: ['"D2Coding"', 'Consolas', 'monospace']
      }
    }
  },
  plugins: []
}

