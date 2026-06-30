import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // Adjust base URL for Electron
  base: "./",

  server: {
    host: "::",
    port: 5173,
    // Disable HMR in development to prevent reload when VPN modifies network routing
    // When running in Electron, HMR reconnection failures cause full page reloads
    // This is especially problematic when VPN connection changes network interfaces
    hmr: false,
  },

  plugins: [
    react(),
  ],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Ensure proper asset handling for Electron
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name.split('.');
          let extType = info[info.length - 1];
          if (/\.(png|jpe?g|svg|gif|tiff|bmp|ico)$/i.test(assetInfo.name)) {
            extType = 'images';
          } else if (/\.(woff2?|eot|ttf|otf)$/i.test(assetInfo.name)) {
            extType = 'fonts';
          }
          return `${extType}/[name]-[hash][extname]`;
        },
        chunkFileNames: 'js/[name]-[hash].js',
        entryFileNames: 'js/[name]-[hash].js'
      }
    }
  },

  // Optimize for Electron environment
  define: {
    global: "globalThis",
  },

  // Ensure proper CSS handling
  css: {
    devSourcemap: true
  }
}));
