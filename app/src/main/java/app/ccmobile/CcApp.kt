package app.ccmobile

import android.app.Application
import android.content.Context
import app.ccmobile.data.Repository
import app.ccmobile.data.Settings
import app.ccmobile.notify.Notifier
import kotlinx.coroutines.MainScope

class CcApp : Application() {
    lateinit var repository: Repository
        private set

    override fun onCreate() {
        super.onCreate()
        repository = Repository(MainScope(), Settings(this))
        Notifier.createChannels(this)
        repository.connect()
    }
}

val Context.repository: Repository get() = (applicationContext as CcApp).repository
