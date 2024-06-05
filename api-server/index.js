const express = require("express");
const { generateSlug } = require("random-word-slugs");
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const { z } = require("zod");
const { PrismaClient, DeploymentStatus } = require("@prisma/client");
const { createClient } = require("@clickhouse/client");
const { Kafka } = require("kafkajs");
const fs = require("fs");
const path = require("path");
const prisma = new PrismaClient({});
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
const PORT = 9000;

const io = new Server({ cors: "*" });

app.use(express.json());
app.use(cors());

const kafka = new Kafka({
  clientId: `api-server`,
  brokers: ["kafka-1d8586de-aadityadeopandeyy-3721.f.aivencloud.com:25585"],
  ssl: {
    ca: [fs.readFileSync(path.join(__dirname, "kafka.pem"), "utf-8")],
  },
  sasl: {
    username: "avnadmin",
    password: "AVNS_ZAi0ZtcP6bM3Lja8TZn",
    mechanism: "plain",
  },
});

const client = createClient({
  host: "https://clickhouse-b9a0987-aadityadeopandeyy-3721.j.aivencloud.com:25573",
  database: "default",
  username: "avnadmin",
  password: "AVNS_Lgoi6tYs0RoS-6dUUk6",
});

const consumer = kafka.consumer({ groupId: "api-server-logs-consumer" });

io.on("connection", (socket) => {
  socket.on("subscribe", (channel) => {
    socket.join(channel);
    socket.emit("message", JSON.stringify({ log: `Subscribed to ${channel}` }));
  });
});
io.listen(9002, () => console.log("Socket server running on port 9002"));

const ecsClient = new ECSClient({
  region: "eu-north-1",
  credentials: {
    accessKeyId: "AKIAVRUVRCIGEXMLYEH4",
    secretAccessKey: "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",
  },
});

const config = {
  CLUSTER: "arn:aws:ecs:eu-north-1:381491941900:cluster/build-cluster",
  TASK: "arn:aws:ecs:eu-north-1:381491941900:task-definition/builder-task",
};

app.post("/project", async (req, res) => {
  const schema = z.object({
    name: z.string(),
    gitUrl: z.string(),
  });
  const safeParseResult = schema.safeParse(req.body);
  if (safeParseResult.error) {
    return res.status(400).json({ error: safeParseResult });
  }
  const { name, gitUrl } = safeParseResult.data;
  const project = await prisma.project.create({
    data: {
      name,
      gitUrl,
      subDomain: generateSlug(),
    },
  });
  return res.json({ status: "success", data: { project } });
});

app.post("/deploy", async (req, res) => {
  const { projectId } = req.body;
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return res.status(404).json({ error: "project not found" });
  }

  const deployment = await prisma.deployment.create({
    data: {
      project: { connect: { id: projectId } },
      status: "QUEUED",
    },
  });

  const command = new RunTaskCommand({
    cluster: config.CLUSTER,
    taskDefinition: config.TASK,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        assignPublicIp: "ENABLED",
        subnets: [
          "subnet-041d6ffd53188d1a4",
          "subnet-00ca2bf478a1df842",
          "subnet-06eecc00b8efaa588",
        ],
        securityGroups: ["sg-0c4a705d717cbcadf"],
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: "builder-image",
          environment: [
            { name: "GIT_REPOSITORY__URL", value: project.gitUrl },
            { name: "PROJECT_ID", value: projectId },
            { name: "DEPLOYMENT_ID", value: deployment.id },
          ],
        },
      ],
    },
  });

  await ecsClient.send(command);

  return res.json({
    status: "queued",
    data: { deploymentId: deployment.id },
  });
});
app.get("/logs/:id", async (req, res) => {
  const id = req.params.id;
  const logs = await client.query({
    query: `SELECT event_id, deployment_id, log, timestamp from log_events where deployment_id = {deployment_id:String}`,
    query_params: {
      deployment_id: id,
    },
    format: "JSONEachRow",
  });

  const rawLogs = await logs.json();

  return res.json({ logs: rawLogs });
});
async function initKafkaConsumer() {
  console.log("Initializing Kafka consumer...");
  await consumer.connect();
  await consumer.subscribe({ topics: ["container-logs"], fromBeginning: true });

  await consumer.run({
    eachBatch: async function ({
      batch,
      heartbeat,
      commitOffsetsIfNecessary,
      resolveOffset,
    }) {
      const messages = batch.messages;
      console.log(`Received ${messages.length} messages`);
      for (const message of messages) {
        const stringMessage = message.value.toString();
        let parsedMessage;
        try {
          parsedMessage = JSON.parse(stringMessage);
        } catch (error) {
          console.error("Failed to parse message:", error);
          continue;
        }

        const { PROJECT_ID, DEPLOYMENT_ID, log } = parsedMessage;

        try {
          const queryResult = await client.insert({
            table: "log_events",
            values: [{ event_id: uuidv4(), deployment_id: DEPLOYMENT_ID, log }],
            format: "JSONEachRow",
          });
          console.log("Insert result:", queryResult);
          resolveOffset(message.offset);
          await commitOffsetsIfNecessary(message.offset);
          await heartbeat();
        } catch (error) {
          console.error("Failed to insert log into ClickHouse:", error);
        }
      }
    },
  });
}

initKafkaConsumer();

app.listen(PORT, () => {
  console.log(`API Server Running on port ${PORT}`);
});
