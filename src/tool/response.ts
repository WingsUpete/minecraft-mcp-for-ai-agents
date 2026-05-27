export type ToolResponse = {
  content: {
    type: "text";
    text: string;
  }[];
  isError?: boolean;
};

export function createToolResponse(message: string): ToolResponse {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}

export function createErrorToolResponse(message: string): ToolResponse {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
}
