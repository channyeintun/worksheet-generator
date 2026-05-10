import { defineConfig } from "vite-plus";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  fmt: {},
  lint: {},
  plugins: [vue()],
});