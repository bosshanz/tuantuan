import { expect, test } from "bun:test";
import { serve } from "../server/app";
import { AttentionService } from "../server/attention";
import { agentInput, until } from "./helpers";

test("attention reflects real pending Host permission and questions across rooms, resolving only through Host actions", async () => {
  const { app, server } = serve({ dbPath: ":memory:" }, 0);
  try {
    const worker = app.store.createAgent(agentInput("AttentionWorker"));
    const permissionRoom = app.store.createRoom("Permission", [worker.id]);
    const questionRoom = app.store.createRoom("Question", [worker.id]);
    const service = new AttentionService(app.store, app.host);
    app.orchestrator.postHumanMessage(permissionRoom.id, "Tester", "/edit");
    app.orchestrator.postHumanMessage(questionRoom.id, "Tester", "/ask");
    const permission = await until(() => app.host.pendingAsks(permissionRoom.id)[0]);
    const question = await until(() => app.host.pendingElicitations(questionRoom.id)[0]);
    expect(
      service
        .list()
        .active.map((item) => item.askId)
        .sort(),
    ).toEqual([permission.id, question.id].sort());
    expect(() => service.dismiss(permission.id)).toThrow("待办消息不存在");
    expect(service.list().active).toHaveLength(2);
    app.host.answer(permission.id, null);
    expect(service.list().active.map((item) => item.askId)).toEqual([question.id]);
    app.host.answerElicitation(question.id, "cancel");
    expect(service.list().active).toEqual([]);
    await app.orchestrator.idle(permissionRoom.id);
    await app.orchestrator.idle(questionRoom.id);
  } finally {
    app.orchestrator.shutdown();
    await Promise.all(app.store.listRooms().map((room) => app.orchestrator.idle(room.id)));
    app.host.shutdown();
    app.installer.shutdown();
    app.registry.stop();
    await app.projectTerminals.shutdown();
    server.stop(true);
    app.store.db.close();
  }
});
