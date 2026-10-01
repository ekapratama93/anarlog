use sqlx::{Executor, Sqlite};

use anlg_cloudsync::{OwnedSqliteConnection, ReservedConnection};

use super::super::{CloudsyncInterruptHandle, CloudsyncTableSpec};

pub(crate) async fn interruptible_cleanup<C: OwnedSqliteConnection>(
    connection: &mut ReservedConnection<C>,
    table_name: &str,
    interrupt: &CloudsyncInterruptHandle,
) -> Result<(), anlg_cloudsync::Error> {
    sqlx::query("SAVEPOINT cloudsync_cleanup")
        .execute(connection.connection().await?)
        .await?;
    let registration = match interrupt.register(connection.connection().await?).await {
        Ok(registration) => registration,
        Err(error) => {
            rollback_cleanup_savepoint(connection).await?;
            return Err(error.into());
        }
    };
    let result = anlg_cloudsync::cleanup_on_connection(connection, table_name).await;
    let finish_result: Result<(), anlg_cloudsync::Error> = match connection.connection().await {
        Ok(connection) => registration.finish(connection).await.map_err(Into::into),
        Err(error) => Err(error),
    };
    if let Err(error) = finish_result {
        rollback_cleanup_savepoint(connection).await?;
        return Err(error);
    }

    match result {
        Ok(()) => match sqlx::query("RELEASE cloudsync_cleanup")
            .execute(connection.connection().await?)
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => {
                rollback_cleanup_savepoint(connection).await?;
                Err(error.into())
            }
        },
        Err(error) => {
            rollback_cleanup_savepoint(connection).await?;
            Err(error)
        }
    }
}

async fn rollback_cleanup_savepoint<C: OwnedSqliteConnection>(
    connection: &mut ReservedConnection<C>,
) -> Result<(), anlg_cloudsync::Error> {
    sqlx::raw_sql("ROLLBACK TO cloudsync_cleanup; RELEASE cloudsync_cleanup")
        .execute(connection.connection().await?)
        .await?;
    Ok(())
}

pub(crate) async fn interruptible_init<C: OwnedSqliteConnection>(
    connection: &mut ReservedConnection<C>,
    table_name: &str,
    crdt_algo: Option<&str>,
    init_flags: Option<i64>,
    interrupt: &CloudsyncInterruptHandle,
) -> Result<(), anlg_cloudsync::Error> {
    let registration = interrupt.register(connection.connection().await?).await?;
    let result =
        anlg_cloudsync::init_on_connection(connection, table_name, crdt_algo, init_flags).await;
    registration.finish(connection.connection().await?).await?;
    result
}

pub(super) async fn init_enabled_tables<C: OwnedSqliteConnection>(
    connection: &mut ReservedConnection<C>,
    tables: &[CloudsyncTableSpec],
    interrupt: &CloudsyncInterruptHandle,
) -> Result<(), anlg_cloudsync::Error> {
    for table in tables.iter().filter(|table| table.enabled) {
        interruptible_init(
            connection,
            &table.table_name,
            table.crdt_algo.as_deref(),
            table.init_flags,
            interrupt,
        )
        .await?;
    }

    Ok(())
}

pub async fn cloudsync_begin_alter_on<'e, E>(
    executor: E,
    table_name: &str,
) -> Result<(), anlg_cloudsync::Error>
where
    E: Executor<'e, Database = Sqlite>,
{
    anlg_cloudsync::begin_alter(executor, table_name).await
}

pub async fn cloudsync_is_enabled_on<'e, E>(
    executor: E,
    table_name: &str,
) -> Result<bool, anlg_cloudsync::Error>
where
    E: Executor<'e, Database = Sqlite>,
{
    anlg_cloudsync::is_enabled(executor, table_name).await
}

pub(crate) async fn cloudsync_has_local_unsent_changes_on<'e, E>(
    executor: E,
) -> Result<bool, anlg_cloudsync::Error>
where
    E: Executor<'e, Database = Sqlite>,
{
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT 1
            FROM cloudsync_changes
            WHERE site_id = (
                SELECT site_id
                FROM cloudsync_site_id
                WHERE rowid = 0
            )
              AND db_version > COALESCE(
                (
                    SELECT CAST(value AS INTEGER)
                    FROM cloudsync_settings
                    WHERE key = 'send_dbversion'
                ),
                0
              )
            LIMIT 1
        )",
    )
    .fetch_one(executor)
    .await?)
}

pub async fn cloudsync_commit_alter_on<'e, E>(
    executor: E,
    table_name: &str,
) -> Result<(), anlg_cloudsync::Error>
where
    E: Executor<'e, Database = Sqlite>,
{
    anlg_cloudsync::commit_alter(executor, table_name).await
}
