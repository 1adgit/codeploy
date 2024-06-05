const express = require("express");
const httpProxy = require("http-proxy");

const PORT = 8000;
const BASE_PATH =
  "https://codeploy-project.s3.ap-south-1.amazonaws.com/__output";

const app = express();
const proxy = httpProxy.createProxyServer();
proxy.on("proxyReq", (proxyReq, req, res) => {
  const url = req.url;
  if (url === "/") {
    proxyReq.path += "index.html";
  }
});
app.listen(PORT, () => {
  console.log(`Reverse Proxy Running on port ${PORT}`);
});

app.use((req, res) => {
  const hostName = req.hostname;
  const subdomain = hostName.split(".")[0];
  const resolvesTo = `${BASE_PATH}/${subdomain}`;

  // console.log(`Proxying request to: ${resolvesTo}${req.url}`); // Log the target URL for debugging

  return proxy.web(
    req,
    res,
    { target: resolvesTo, changeOrigin: true },
    (err) => {
      // if (err) {
      //   console.error(`Proxy error: ${err.message}`);
      //   res.status(500).send("Proxy error");
      // }
    }
  );
});

proxy.on("error", (err, req, res) => {
  console.error(`Proxy error: ${err.message}`);
  res.status(500).send("Proxy error");
});
