# HandCam on one always-on server (Render, Fly, Railway…): Node for the app, Python + OpenCV for the move-match checker,
# ffmpeg + a font for the free-trial watermark.
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip libglib2.0-0 ffmpeg fonts-dejavu-core \
 && pip3 install --no-cache-dir --break-system-packages opencv-python-headless numpy \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production PORT=10000 DATA_DIR=/var/data
EXPOSE 10000
CMD ["node", "server/index.js"]
