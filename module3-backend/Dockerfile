# Only libreoffice-writer (not the full libreoffice suite) - keeps the
# image smaller and the build faster, since Writer is all that's needed
# for .docx -> PDF. Fonts matter more than people expect: without a
# reasonable set installed, LibreOffice silently substitutes fonts and
# text can shift/overflow compared to how the doc looks in actual Word.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    fonts-liberation \
    fonts-dejavu \
    fonts-crosextra-carlito \
    fonts-crosextra-caladea \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=4000
EXPOSE 4000
CMD ["node", "src/server.js"]
