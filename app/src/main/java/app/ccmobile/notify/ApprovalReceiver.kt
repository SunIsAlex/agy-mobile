package app.ccmobile.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.ccmobile.data.Approval
import app.ccmobile.repository

/** Handles the Allow / Deny buttons on an approval notification. */
class ApprovalReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val requestId = intent.getStringExtra(EXTRA_REQUEST) ?: return
        val repository = context.repository
        val approval = repository.approvals.value.firstOrNull { it.requestId == requestId }
        Notifier.cancelApproval(context, requestId)
        // Already answered elsewhere (in the app or another device): nothing to do.
        approval ?: return
        repository.answer(approval, allow = intent.getStringExtra(EXTRA_DECISION) == "allow")
    }

    companion object {
        private const val EXTRA_REQUEST = "request"
        private const val EXTRA_DECISION = "decision"

        fun intent(context: Context, approval: Approval, decision: String) =
            Intent(context, ApprovalReceiver::class.java)
                .putExtra(EXTRA_REQUEST, approval.requestId)
                .putExtra(EXTRA_DECISION, decision)
    }
}
