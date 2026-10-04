import {fileURLToPath}from 'node:url';
export default {output:'standalone',outputFileTracingRoot:fileURLToPath(new URL('..',import.meta.url)),poweredByHeader:false,
  async headers(){return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'same-origin'},{key:'X-Frame-Options',value:'DENY'}]}];}};
