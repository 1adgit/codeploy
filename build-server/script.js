require("dotenv").config();
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { Kafka } = require("kafkajs");

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const PROJECT_ID = process.env.PROJECT_ID;
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID;

const kafka = new Kafka({
  clientId: `docker-build-server-${DEPLOYMENT_ID}`,
  brokers: [process.env.KAFKA_BROKER_URL],
  ssl: {
    ca: [
      fs.readFileSync(path.join(__dirname, process.env.KAFKA_CA_PATH), "utf-8"),
    ],
  },
  sasl: {
    username: process.env.KAFKA_USERNAME,
    password: process.env.KAFKA_PASSWORD,
    mechanism: "plain",
  },
});

const producer = kafka.producer();

async function publishLog(log) {
  await producer.send({
    topic: `container-logs`,
    messages: [
      { key: "log", value: JSON.stringify({ PROJECT_ID, DEPLOYMENT_ID, log }) },
    ],
  });
}

async function init() {
  await producer.connect();
  console.log("executing script.js");
  await publishLog("Build Started ...");
  const outDirPath = path.join(__dirname, "output");
  const p = exec(`cd ${outDirPath} && npm install && npm run build`);

  p.stdout.on("data", async function (data) {
    console.log(data.toString());
    await publishLog(data.toString());
  });

  p.stderr.on("data", async function (data) {
    console.log("error", data.toString());
    await publishLog(`error:${data.toString()}`);
  });

  p.on("close", async function () {
    console.log("build complete");
    await publishLog("Build Complete");
    const distFolderPath = path.join(__dirname, "output", "dist");
    const distFolderContents = fs.readdirSync(distFolderPath, {
      recursive: true,
    });
    await publishLog("starting to upload");
    for (const file of distFolderContents) {
      const filePath = path.join(distFolderPath, file);
      if (fs.lstatSync(filePath).isDirectory()) continue;

      console.log("uploading", filePath);
      await publishLog(`uploading ${file}`);
      const command = new PutObjectCommand({
        Bucket: "codeploy-project",
        Key: `__output/${PROJECT_ID}/${file}`,
        Body: fs.createReadStream(filePath),
        ContentType: mime.lookup(filePath),
      });

      await s3Client.send(command);
      await publishLog(`uploaded ${file}`);
      console.log("uploaded", filePath);
    }
    await publishLog(`done`);
    console.log("done...");
    process.exit(0);
  });
}

init();
