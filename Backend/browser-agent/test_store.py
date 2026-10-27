import sqlite3

import store


def test_conversations_are_separated_and_listed(monkeypatch, tmp_path):
    database = tmp_path / "history.db"
    monkeypatch.setattr(store, "get_db_path", lambda: str(database))
    store.init_db()

    first = store.create_conversation("deepseek", "First task")
    second = store.create_conversation("deepseek", "Second task")
    store.save_message("deepseek", "user", "First prompt", first["id"])
    store.save_message("deepseek", "assistant", "First answer", first["id"])
    store.save_message("deepseek", "user", "Second prompt", second["id"])

    assert [item["id"] for item in store.list_conversations("deepseek")] == [second["id"], first["id"]]
    assert [item["content"] for item in store.recent_messages("deepseek", conversation_id=first["id"])] == [
        "First prompt", "First answer"
    ]


def test_existing_per_model_messages_migrate_to_legacy_conversation(monkeypatch, tmp_path):
    database = tmp_path / "old-history.db"
    monkeypatch.setattr(store, "get_db_path", lambda: str(database))
    conn = sqlite3.connect(database)
    conn.execute(
        "CREATE TABLE messages (id INTEGER PRIMARY KEY, model_name TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)"
    )
    conn.execute("INSERT INTO messages (model_name, role, content) VALUES ('chatgpt', 'user', 'Old question')")
    conn.execute("INSERT INTO messages (model_name, role, content) VALUES ('chatgpt', 'assistant', 'Old answer')")
    conn.commit()
    conn.close()

    store.init_db()

    conversations = store.list_conversations("chatgpt")
    assert len(conversations) == 1
    assert conversations[0]["title"] == "Old question"
    assert [item["content"] for item in store.recent_messages("chatgpt", conversation_id=conversations[0]["id"])] == [
        "Old question", "Old answer"
    ]


def test_delete_conversation_removes_only_its_messages(monkeypatch, tmp_path):
    database = tmp_path / "delete-history.db"
    monkeypatch.setattr(store, "get_db_path", lambda: str(database))
    store.init_db()
    first = store.create_conversation("deepseek", "Delete me")
    second = store.create_conversation("deepseek", "Keep me")
    store.save_message("deepseek", "user", "First prompt", first["id"])
    store.save_message("deepseek", "user", "Second prompt", second["id"])

    assert store.delete_conversation("deepseek", first["id"])
    assert store.delete_conversation("deepseek", first["id"]) is False
    assert [item["id"] for item in store.list_conversations("deepseek")] == [second["id"]]
    assert [item["content"] for item in store.recent_messages("deepseek", conversation_id=second["id"])] == ["Second prompt"]
