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
const PORT = process.env.PORT || 9000;
const SOCKET_PORT = process.env.SOCKET_PORT || 9002;

const io = new Server({ cors: "*" });

app.use(express.json());
app.use(cors());

const kafka = new Kafka({
  clientId: `api-server`,
  brokers: [process.env.KAFKA_BROKER_URL],
  ssl: {
    ca: [fs.readFileSync(process.env.KAFKA_CA_PATH, "utf-8")],
  },
  sasl: {
    username: process.env.KAFKA_USERNAME,
    password: process.env.KAFKA_PASSWORD,
    mechanism: "plain",
  },
});

const client = createClient({
  host: process.env.CLICKHOUSE_HOST,
  database: process.env.CLICKHOUSE_DATABASE,
  username: process.env.CLICKHOUSE_USERNAME,
  password: process.env.CLICKHOUSE_PASSWORD,
});

const consumer = kafka.consumer({ groupId: "api-server-logs-consumer" });

io.on("connection", (socket) => {
  socket.on("subscribe", (channel) => {
    socket.join(channel);
    socket.emit("message", JSON.stringify({ log: `Subscribed to ${channel}` }));
  });
});
io.listen(SOCKET_PORT, () =>
  console.log(`Socket server running on port ${SOCKET_PORT}`)
);

const ecsClient = new ECSClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const config = {
  CLUSTER: process.env.CLUSTER,
  TASK: process.env.TASK,
};

app.post("/project", async (req, res) => {
  const schema = z.object({
    name: z.string(),
    gitUrl: z.string(),
  });
  const safeParseResult = schema.safeParse(req.body);
  if (safeParseResult.error) {
    return res.status(400).json({ error: safeParseResult.error });
  }
  const { name, gitUrl } = safeParseResult.data;
  try {
    const project = await prisma.project.create({
      data: {
        name,
        gitUrl,
        subDomain: generateSlug(),
      },
    });
    return res.json({ status: "success", data: { project } });
  } catch (error) {
    return res.status(500).json({ error: "Failed to create project" });
  }
});

app.post("/deploy", async (req, res) => {
  const { projectId } = req.body;
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return res.status(404).json({ error: "project not found" });
  }

  try {
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
          subnets: process.env.SUBNETS.split(","),
          securityGroups: process.env.SECURITY_GROUPS.split(","),
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "builder-image",
            environment: [
              { name: "GIT_REPOSITORY_URL", value: project.gitUrl },
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
  } catch (error) {
    return res.status(500).json({ error: "Failed to queue deployment" });
  }
});

app.get("/logs/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const logs = await client.query({
      query: `SELECT event_id, deployment_id, log, timestamp from log_events where deployment_id = {deployment_id:String}`,
      query_params: {
        deployment_id: id,
      },
      format: "JSONEachRow",
    });

    const rawLogs = await logs.json();

    return res.json({ logs: rawLogs });
  } catch (error) {
    return res.status(500).json({ error: "Failed to retrieve logs" });
  }
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
