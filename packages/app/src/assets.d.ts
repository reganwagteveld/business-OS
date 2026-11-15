// Vite turns `import x from 'file?url'` into the file's final URL (used for the PDF.js worker).
declare module '*?url' {
  const url: string;
  export default url;
}
