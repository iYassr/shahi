/** Synthetic API 5 pages generated from normaliseOpenCode/normaliseAntigravity.
 * Shared by web/native rendering tests; these contain no captured user content. */
import type { SessionLog } from '../src/index';

export const providerReaderFixtures: { agent: string; label: string; command: string; output: string; deniedCommand: string; error: string; thinking: string; question: string; log: SessionLog }[] = [
  {
    "agent": "opencode",
    "label": "OpenCode",
    "command": "printf OPEN_CODE_READER",
    "output": "OPEN_CODE_READER",
    "deniedCommand": "rm protected-demo.txt",
    "error": "Permission denied by the user.",
    "thinking": "I will inspect the sample before changing it.",
    "question": "Publish the change?",
    "log": {
      "sessionId": "ses_readerdemo",
      "path": "/home/demo/.local/share/opencode/opencode.db#ses_readerdemo",
      "messages": [
        {
          "id": "ses_readerdemo:msg_user",
          "role": "you",
          "at": 1790490366000,
          "blocks": [
            {
              "kind": "text",
              "text": "Read the sample and change it to ready."
            }
          ]
        },
        {
          "id": "ses_readerdemo:msg_tools",
          "role": "agent",
          "at": 1790490366000,
          "blocks": [
            {
              "kind": "thinking",
              "text": "I will inspect the sample before changing it."
            },
            {
              "kind": "tool",
              "name": "edit",
              "summary": "/workspace/status.txt",
              "file": {
                "path": "/workspace/status.txt",
                "name": "status.txt"
              },
              "result": {
                "text": "Updated status.txt\n\n@@ -1 +1 @@\n-waiting\n+ready",
                "isError": false,
                "truncated": false,
                "images": []
              }
            },
            {
              "kind": "tool",
              "name": "bash",
              "summary": "printf OPEN_CODE_READER",
              "result": {
                "text": "OPEN_CODE_READER",
                "isError": false,
                "truncated": false,
                "images": []
              }
            },
            {
              "kind": "tool",
              "name": "bash",
              "summary": "rm protected-demo.txt",
              "result": {
                "text": "Permission denied by the user.",
                "isError": true,
                "truncated": false,
                "images": []
              }
            },
            {
              "kind": "tool",
              "name": "question",
              "summary": "Publish the change?",
              "questions": [
                {
                  "text": "Publish the change?",
                  "options": [
                    {
                      "label": "Keep reviewing"
                    },
                    {
                      "label": "Ready"
                    }
                  ]
                }
              ],
              "result": {
                "text": "Keep reviewing",
                "isError": false,
                "truncated": false,
                "images": []
              }
            }
          ]
        },
        {
          "id": "ses_readerdemo:msg_reply",
          "role": "agent",
          "at": 1790490366000,
          "blocks": [
            {
              "kind": "text",
              "text": "The sample is ready."
            }
          ]
        }
      ],
      "total": 3,
      "offset": 0
    }
  },
  {
    "agent": "agy",
    "label": "Antigravity",
    "command": "printf ANTIGRAVITY_READER",
    "output": "ANTIGRAVITY_READER",
    "deniedCommand": "rm protected-demo.txt",
    "error": "Permission denied by the user.",
    "thinking": "I will inspect the sample before changing it.",
    "question": "Publish the change?",
    "log": {
      "sessionId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "path": "/home/demo/.gemini/antigravity-cli/brain/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/.system_generated/logs/transcript.jsonl",
      "messages": [
        {
          "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:agy-0",
          "at": 1790490366000,
          "role": "you",
          "blocks": [
            {
              "kind": "text",
              "text": "Read the sample and change it to ready."
            }
          ]
        },
        {
          "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:agy-1",
          "at": 1790490366000,
          "role": "agent",
          "blocks": [
            {
              "kind": "thinking",
              "text": "I will inspect the sample before changing it."
            },
            {
              "kind": "tool",
              "name": "replace_file_content",
              "summary": "/workspace/status.txt",
              "file": {
                "path": "/workspace/status.txt",
                "name": "status.txt"
              },
              "result": {
                "text": "@@ -1 +1 @@\n-waiting\n+ready",
                "isError": false,
                "truncated": false,
                "images": []
              }
            }
          ]
        },
        {
          "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:agy-3",
          "at": 1790490366000,
          "role": "agent",
          "blocks": [
            {
              "kind": "tool",
              "name": "run_command",
              "summary": "printf ANTIGRAVITY_READER",
              "result": {
                "text": "ANTIGRAVITY_READER",
                "isError": false,
                "truncated": false,
                "images": []
              }
            }
          ]
        },
        {
          "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:agy-5",
          "at": 1790490366000,
          "role": "agent",
          "blocks": [
            {
              "kind": "tool",
              "name": "run_command",
              "summary": "rm protected-demo.txt",
              "result": {
                "text": "Permission denied by the user.",
                "isError": true,
                "truncated": false,
                "images": []
              }
            }
          ]
        },
        {
          "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:agy-7",
          "at": 1790490366000,
          "role": "agent",
          "blocks": [
            {
              "kind": "tool",
              "name": "ask_question",
              "summary": "",
              "questions": [
                {
                  "text": "Publish the change?",
                  "options": [
                    {
                      "label": "Keep reviewing"
                    },
                    {
                      "label": "Ready"
                    }
                  ]
                }
              ],
              "result": {
                "text": "Keep reviewing",
                "isError": false,
                "truncated": false,
                "images": []
              }
            }
          ]
        },
        {
          "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:agy-9",
          "at": 1790490366000,
          "role": "agent",
          "blocks": [
            {
              "kind": "text",
              "text": "The sample is ready."
            }
          ]
        }
      ],
      "total": 6,
      "offset": 0
    }
  }
];
