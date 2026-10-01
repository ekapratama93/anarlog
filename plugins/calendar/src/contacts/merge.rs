use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;

use crate::contacts::run_write;
use crate::storage::transaction_utils::js_iso8601_timestamp;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MergeHumansRequest {
    pub selected_human_id: String,
    pub duplicate_human_id: String,
}

fn merge_text(primary: &str, duplicate: &str) -> String {
    if duplicate.is_empty() {
        return primary.to_string();
    }
    if !primary.is_empty() {
        return format!("{primary}, {duplicate}");
    }
    duplicate.to_string()
}

pub async fn merge_humans(pool: &SqlitePool, request: MergeHumansRequest) -> Result<(), String> {
    let now = js_iso8601_timestamp();
    let selected = request.selected_human_id;
    let duplicate = request.duplicate_human_id;
    run_write(pool, |conn| {
        let now = now.clone();
        Box::pin(async move {
            let rows = anlg_db_app::list_merge_humans(conn, &selected, &duplicate)
                .await
                .map_err(|error| error.to_string())?;
            let self_human_id = rows
                .iter()
                .find(|row| row.id == row.owner_user_id)
                .map(|row| row.id.clone())
                .unwrap_or_else(|| {
                    if duplicate == anlg_db_app::DEFAULT_USER_ID {
                        duplicate.clone()
                    } else {
                        selected.clone()
                    }
                });
            let primary_id = if self_human_id == duplicate {
                duplicate.clone()
            } else {
                selected.clone()
            };
            let duplicate_id = if primary_id == selected {
                duplicate.clone()
            } else {
                selected.clone()
            };
            let Some(primary) = rows.iter().find(|row| row.id == primary_id) else {
                return Err("Both contacts must exist before they can be merged".to_string());
            };
            let Some(duplicate_row) = rows.iter().find(|row| row.id == duplicate_id) else {
                return Err("Both contacts must exist before they can be merged".to_string());
            };
            let organization_id = if primary.organization_id.is_empty() {
                duplicate_row.organization_id.clone()
            } else {
                primary.organization_id.clone()
            };
            let job_title = merge_text(&primary.job_title, &duplicate_row.job_title);
            let linkedin_username =
                merge_text(&primary.linkedin_username, &duplicate_row.linkedin_username);
            let phone = merge_text(&primary.phone, &duplicate_row.phone);
            let memo = merge_text(&primary.memo, &duplicate_row.memo);

            anlg_db_app::tombstone_duplicate_participant_mappings(
                conn,
                &now,
                &duplicate_id,
                &primary_id,
            )
            .await
            .map_err(|error| error.to_string())?;
            anlg_db_app::reassign_participant_mappings(conn, &primary_id, &duplicate_id, &now)
                .await
                .map_err(|error| error.to_string())?;
            anlg_db_app::update_merged_human(
                conn,
                &job_title,
                &linkedin_username,
                &phone,
                &memo,
                &organization_id,
                &now,
                &primary_id,
            )
            .await
            .map_err(|error| error.to_string())?;
            anlg_db_app::soft_delete_contact(conn, "humans", &duplicate_id, &now)
                .await
                .map_err(|error| error.to_string())?;
            Ok(())
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use anlg_db_core::Db;

    async fn test_db() -> Db {
        let db = Db::connect_memory_plain().await.unwrap();
        anlg_db_app::prepare_schema(&db).await.unwrap();
        db
    }

    async fn seed_human(db: &Db, id: &str, owner: &str, org: &str, title: &str, memo: &str) {
        sqlx::query(
            "INSERT INTO humans (id, owner_user_id, name, organization_id, job_title, memo)
             VALUES (?, ?, 'N', ?, ?, ?)",
        )
        .bind(id)
        .bind(owner)
        .bind(org)
        .bind(title)
        .bind(memo)
        .execute(db.pool())
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn merges_mappings_fields_and_tombstones_the_duplicate() {
        let db = test_db().await;
        seed_human(&db, "primary", "u", "", "Engineer", "Primary").await;
        seed_human(&db, "duplicate", "u", "org-1", "Founder", "Duplicate").await;
        sqlx::query("INSERT INTO sessions (id, owner_user_id) VALUES ('s1', 'u'), ('s2', 'u')")
            .execute(db.pool())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO session_participants (id, session_id, human_id, source)
             VALUES ('m1', 's1', 'duplicate', 'invite'),
                    ('m2', 's1', 'primary', 'invite'),
                    ('m3', 's2', 'duplicate', 'invite')",
        )
        .execute(db.pool())
        .await
        .unwrap();

        merge_humans(
            db.pool(),
            MergeHumansRequest {
                selected_human_id: "primary".to_string(),
                duplicate_human_id: "duplicate".to_string(),
            },
        )
        .await
        .unwrap();

        // Mapping m1: duplicate already had primary in s1 -> tombstoned.
        // Mapping m3: no primary counterpart -> reassigned to primary.
        let mappings: Vec<(String, String, bool)> = sqlx::query_as(
            "SELECT id, human_id, deleted_at IS NOT NULL FROM session_participants ORDER BY id",
        )
        .fetch_all(db.pool())
        .await
        .unwrap();
        assert_eq!(
            mappings,
            vec![
                ("m1".to_string(), "duplicate".to_string(), true),
                ("m2".to_string(), "primary".to_string(), false),
                ("m3".to_string(), "primary".to_string(), false),
            ]
        );

        let (job_title, memo, org, deleted): (String, String, String, Option<String>) =
            sqlx::query_as(
                "SELECT job_title, memo, organization_id, deleted_at FROM humans WHERE id = 'primary'",
            )
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(job_title, "Engineer, Founder");
        assert_eq!(memo, "Primary, Duplicate");
        assert_eq!(org, "org-1");
        assert!(deleted.is_none());

        let dup_deleted: Option<String> =
            sqlx::query_scalar("SELECT deleted_at FROM humans WHERE id = 'duplicate'")
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert!(dup_deleted.is_some());
    }

    #[tokio::test]
    async fn keeps_the_bound_self_human_when_selected_as_duplicate() {
        let db = test_db().await;
        seed_human(&db, "other", "user-1", "", "", "").await;
        // Bound self human: id == owner_user_id.
        seed_human(&db, "user-1", "user-1", "", "", "").await;

        merge_humans(
            db.pool(),
            MergeHumansRequest {
                selected_human_id: "other".to_string(),
                duplicate_human_id: "user-1".to_string(),
            },
        )
        .await
        .unwrap();

        let deleted: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT id, deleted_at FROM humans ORDER BY id")
                .fetch_all(db.pool())
                .await
                .unwrap();
        assert_eq!(deleted[0].0, "other");
        assert!(deleted[0].1.is_some());
        assert_eq!(deleted[1].0, "user-1");
        assert!(deleted[1].1.is_none());
    }

    #[tokio::test]
    async fn missing_contact_errors_without_writes() {
        let db = test_db().await;
        seed_human(&db, "primary", "u", "", "", "").await;

        let error = merge_humans(
            db.pool(),
            MergeHumansRequest {
                selected_human_id: "primary".to_string(),
                duplicate_human_id: "missing".to_string(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Both contacts must exist before they can be merged");

        let deleted: Option<String> =
            sqlx::query_scalar("SELECT deleted_at FROM humans WHERE id = 'primary'")
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert!(deleted.is_none());
    }

    #[tokio::test]
    async fn a_mid_transaction_failure_rolls_back_earlier_statements() {
        let db = test_db().await;
        seed_human(&db, "primary", "u", "", "Eng", "").await;
        seed_human(&db, "duplicate", "u", "", "", "").await;
        sqlx::query("INSERT INTO sessions (id, owner_user_id) VALUES ('s1', 'u')")
            .execute(db.pool())
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO session_participants (id, session_id, human_id, source)
             VALUES ('m1', 's1', 'duplicate', 'invite')",
        )
        .execute(db.pool())
        .await
        .unwrap();
        sqlx::query(
            "CREATE TRIGGER block_human_updates BEFORE UPDATE ON humans
             WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'boom'); END",
        )
        .execute(db.pool())
        .await
        .unwrap();

        merge_humans(
            db.pool(),
            MergeHumansRequest {
                selected_human_id: "primary".to_string(),
                duplicate_human_id: "duplicate".to_string(),
            },
        )
        .await
        .unwrap_err();

        let mapping: (String, Option<String>) =
            sqlx::query_as("SELECT human_id, deleted_at FROM session_participants WHERE id = 'm1'")
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert_eq!(mapping.0, "duplicate");
        assert!(mapping.1.is_none());
        let dup_deleted: Option<String> =
            sqlx::query_scalar("SELECT deleted_at FROM humans WHERE id = 'duplicate'")
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert!(dup_deleted.is_none());
    }
}
