"use server";
import "server-only";

import { userHashedId, userSession } from "@/features/auth/helpers";
import { FindAllChats } from "@/features/chat/chat-services/chat-service";
import { SqlQuerySpec } from "@azure/cosmos";
import { nanoid } from "nanoid";
import { CosmosDBContainer } from "../../common/cosmos";
import {
  CHAT_THREAD_ATTRIBUTE,
  ChatMessageModel,
  ChatModel,
  ChatThreadModel,
  ChatType,
  ConversationStyle,
  PromptGPTProps,
} from "./models";
import { FindAllChatDocuments, DeleteDocuments } from "./chat-document-service";

export const FindAllChatThreadForCurrentUser = async () => {
  const container = await CosmosDBContainer.getInstance().getContainer();

  const querySpec: SqlQuerySpec = {
    query:
      "SELECT * FROM root r WHERE r.type=@type AND r.userId=@userId AND r.isDeleted=@isDeleted ORDER BY r.createdAt DESC",
    parameters: [
      {
        name: "@type",
        value: CHAT_THREAD_ATTRIBUTE,
      },
      {
        name: "@userId",
        value: await userHashedId(),
      },
      {
        name: "@isDeleted",
        value: false,
      },
    ],
  };

  const { resources } = await container.items
    .query<ChatThreadModel>(querySpec, {
      partitionKey: await userHashedId(),
    })
    .fetchAll();
  return resources;
};

export const FindChatThreadByID = async (id: string) => {
  const container = await CosmosDBContainer.getInstance().getContainer();

  const querySpec: SqlQuerySpec = {
    query:
      "SELECT * FROM root r WHERE r.type=@type AND r.userId=@userId AND r.id=@id AND r.isDeleted=@isDeleted",
    parameters: [
      {
        name: "@type",
        value: CHAT_THREAD_ATTRIBUTE,
      },
      {
        name: "@userId",
        value: await userHashedId(),
      },
      {
        name: "@id",
        value: id,
      },
      {
        name: "@isDeleted",
        value: false,
      },
    ],
  };

  const { resources } = await container.items
    .query<ChatThreadModel>(querySpec)
    .fetchAll();

  return resources;
};

export const SoftDeleteChatThreadByID = async (chatThreadID: string) => {
  const container = await CosmosDBContainer.getInstance().getContainer();
  const threads = await FindChatThreadByID(chatThreadID);

  if (threads.length !== 0) {
    const chats = await FindAllChats(chatThreadID);

    chats.forEach(async (chat) => {
      const itemToUpdate = {
        ...chat,
      };
      itemToUpdate.isDeleted = true;
      await container.items.upsert(itemToUpdate);
    });

    const chatDocuments = await FindAllChatDocuments(chatThreadID);

    if (chatDocuments.length !== 0) {
      await DeleteDocuments(chatThreadID);
    }

    chatDocuments.forEach(async (chatDocument) => {
      const itemToUpdate = {
        ...chatDocument,
      };
      itemToUpdate.isDeleted = true;
      await container.items.upsert(itemToUpdate);
    });

    threads.forEach(async (thread) => {
      const itemToUpdate = {
        ...thread,
      };
      itemToUpdate.isDeleted = true;
      await container.items.upsert(itemToUpdate);
    });
  }
};

export const EnsureChatThreadIsForCurrentUser = async (
  chatThreadID: string
) => {
  const modelToSave = await FindChatThreadByID(chatThreadID);
  if (modelToSave.length === 0) {
    throw new Error("Chat thread not found");
  }

  return modelToSave[0];
};

export const UpsertChatThread = async (chatThread: ChatThreadModel) => {
  const container = await CosmosDBContainer.getInstance().getContainer();
  const updatedChatThread = await container.items.upsert<ChatThreadModel>(
    chatThread
  );

  if (updatedChatThread === undefined) {
    throw new Error("Chat thread not found");
  }

  return updatedChatThread;
};

export const updateChatThreadTitle = async (
  chatThread: ChatThreadModel,
  messages: ChatMessageModel[],
  chatType: ChatType,
  chatModel: ChatModel,
  conversationStyle: ConversationStyle,
  chatOverFileName: string,
  userMessage: string
) => {
  if (messages.length === 0) {
    const updatedChatThread = await UpsertChatThread({
      ...chatThread,
      chatType: chatType,
      chatModel: chatModel,
      chatOverFileName: chatOverFileName,
      conversationStyle: conversationStyle,
      name: userMessage.substring(0, 30),
    });

    return updatedChatThread.resource!;
  }

  return chatThread;
};

export const CreateChatThread = async () => {
  const modelToSave: ChatThreadModel = {
    name: "Empty Chat",
    useName: (await userSession())!.name,
    userId: await userHashedId(),
    id: nanoid(),
    createdAt: new Date(),
    isDeleted: false,
    chatType: "simple",
    chatModel: "gpt-4",
    conversationStyle: "precise",
    type: CHAT_THREAD_ATTRIBUTE,
    chatOverFileName: ""
  };

  const container = await CosmosDBContainer.getInstance().getContainer();
  const response = await container.items.create<ChatThreadModel>(modelToSave);
  return response.resource;
};

export const initAndGuardChatSession = async (props: PromptGPTProps) => {
  const { messages, id, chatType, chatModel, conversationStyle, chatOverFileName } = props;

  //last message
  const lastHumanMessage = messages[messages.length - 1];

  const currentChatThread = await EnsureChatThreadIsForCurrentUser(id);
  const chats = await FindAllChats(id);

  const chatThread = await updateChatThreadTitle(
    currentChatThread,
    chats,
    chatType,
    chatModel,
    conversationStyle,
    chatOverFileName,
    lastHumanMessage.content
  );

  return {
    id,
    lastHumanMessage,
    chats,
    chatThread,
  };
};
